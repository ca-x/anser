import { signal, Text, View } from "nsh";
import { ApiError, type AnserApi } from "../api";
import type { Account, Channel, Format, JsonObject } from "../contracts";
import { integer, tagsFrom } from "../forms";
import {
  Action,
  Choice,
  confirm,
  Field,
  Hint,
  Panel,
  Problem,
  ReadState,
  Section,
  Toggle,
} from "../components/Controls";
import { channelConfigDraft, ChannelConfig } from "../components/ChannelConfig";
import { RecordRow, WorkspacePage } from "../components/Workspace";
import { operation, paged } from "../state";

export function Accounts(props: {
  api: AnserApi;
  channels: Channel[];
  onOpen: (account: Account) => void;
  onCreate: () => void;
}) {
  const list = paged(props.api.accounts.bind(props.api));
  return (
    <WorkspacePage title="渠道账号">
      <View class="flex-row flex-wrap justify-between gap-2">
        <Action
          label="刷新"
          kind="quiet"
          onPress={list.reload}
          disabled={list.loading()}
        />
        <Action label="添加账号" kind="primary" onPress={props.onCreate} />
      </View>
      <ReadState
        loading={list.loading()}
        problem={list.problem()}
        empty={!list.items().length}
        emptyLabel="还没有渠道账号。添加账号后可以测试发送。"
      />
      <Each of={list.items()} key={(account) => account.id}>
        {(account) => (
          <RecordRow
            title={account().name}
            subtitle={[
              props.channels.find((channel) => channel.id === account().channel)
                ?.display_name ?? account().channel,
              ...(account().tags ?? []),
            ].join(" / ")}
            status={
              <Text
                class={
                  account().enabled
                    ? "text-sm text-success"
                    : "text-sm text-muted-foreground"
                }
              >
                {account().enabled ? "已启用" : "已停用"}
              </Text>
            }
            onPress={() => props.onOpen(account())}
          />
        )}
      </Each>
      <If when={list.next()}>
        <Action
          label="加载更多"
          onPress={list.more}
          disabled={list.loading()}
        />
      </If>
    </WorkspacePage>
  );
}

export function AccountEditor(props: {
  api: AnserApi;
  channels: Channel[];
  account?: Account;
  onBack: () => void;
  onSaved: (account: Account) => void;
  onDeleted: () => void;
}) {
  const original = props.account;
  const name = signal(original?.name ?? "");
  const channelId = signal(original?.channel ?? "");
  const channel = () =>
    props.channels.find((entry) => entry.id === channelId());
  const tags = signal((original?.tags ?? []).join(", "));
  const weight = signal(String(original?.weight ?? 1));
  const priority = signal(String(original?.priority ?? 0));
  const limit = signal(
    original?.rate_limit == null ? "" : String(original.rate_limit),
  );
  const enabled = signal(original?.enabled ?? true);
  const replaceConfig = signal(!original);
  const config = channelConfigDraft(channel);
  const action = operation();
  const test = operation();
  const testing = signal(false);
  const testTitle = signal("雁字测试");
  const testBody = signal("这是一条来自雁字的测试通知。");
  const testFormat = signal<Format>("text");
  const testResult = signal("");

  function save() {
    void action.run(async () => {
      if (!name().trim() || !channelId())
        throw new ApiError("invalid_account", "请填写账号名称并选择渠道。");
      const data: JsonObject = {
        name: name().trim(),
        tags: tagsFrom(tags()),
        weight: integer(weight(), "权重", 0, 4294967295),
        priority: integer(priority(), "优先级", -2147483648, 2147483647),
        rate_limit: limit().trim()
          ? integer(limit(), "每分钟限速", 1, 60000)
          : null,
        enabled: enabled(),
      };
      if (!original) data.channel = channelId();
      if (replaceConfig()) data.config = config.value();
      const saved = await props.api.saveAccount(original?.id, data);
      if (!action.live()) return;
      config.clear();
      props.onSaved(saved);
    });
  }

  function remove() {
    void action.run(async () => {
      if (
        !original ||
        !(await confirm(
          "删除账号？",
          "该账号将从路由的可用目标中移除。",
          "删除账号",
        ))
      )
        return;
      await props.api.deleteAccount(original.id);
      if (action.live()) props.onDeleted();
    });
  }

  function testSend() {
    void test.run(async () => {
      if (!original) return;
      testResult.set("");
      const result = await props.api.testAccount(original.id, {
        title: testTitle().trim(),
        body: testBody(),
        format: testFormat(),
      });
      if (!test.live()) return;
      testResult.set(
        typeof result === "object" &&
          result !== null &&
          "status" in result &&
          result.status === "accepted"
          ? "渠道已接收请求，结果仍在处理中。"
          : "渠道已接收测试通知。",
      );
    });
  }

  return (
    <WorkspacePage
      title={original ? "编辑账号" : "添加账号"}
      back={props.onBack}
      footer={
        <View class="flex-row flex-wrap gap-2">
          <Action
            label={action.busy() ? "正在保存…" : "保存账号"}
            kind="primary"
            onPress={save}
            disabled={action.busy() || test.busy()}
          />
          <Action
            label="取消"
            kind="quiet"
            onPress={props.onBack}
            disabled={action.busy() || test.busy()}
          />
        </View>
      }
    >
      <Problem message={action.problem()} />
      <Panel>
        <Field label="账号名称" value={name()} onChange={name.set} />
        <Choice
          label="渠道"
          value={channelId() || null}
          items={props.channels.map((entry) => ({
            value: entry.id,
            title: entry.display_name,
          }))}
          disabled={Boolean(original)}
          onChange={(value) => {
            channelId.set(value ?? "");
            config.clear();
          }}
        />
        <Field
          label="标签"
          value={tags()}
          onChange={tags.set}
          hint="多个标签用逗号分隔。"
        />
        <View class="gap-3 md:flex-row">
          <View class="flex-1">
            <Field
              label="权重"
              value={weight()}
              onChange={weight.set}
              keyboard="numeric"
              hint="0 用作加权兜底。"
            />
          </View>
          <View class="flex-1">
            <Field
              label="优先级"
              value={priority()}
              onChange={priority.set}
              keyboard="numeric"
              hint="值越小越先尝试。"
            />
          </View>
          <View class="flex-1">
            <Field
              label="每分钟限速"
              value={limit()}
              onChange={limit.set}
              keyboard="numeric"
            />
          </View>
        </View>
        <Toggle label="启用账号" checked={enabled()} onChange={enabled.set} />
      </Panel>
      <If when={channelId()}>
        <Section title="渠道配置">
          <If when={original}>
            <Toggle
              label="替换已保存的配置"
              checked={replaceConfig()}
              onChange={(value) => {
                replaceConfig.set(value);
                if (!value) config.clear();
              }}
            />
            <Hint>已保存的凭据不会传回客户端。替换时请重新填写完整配置。</Hint>
          </If>
          <If when={replaceConfig()}>
            <ChannelConfig draft={config} />
          </If>
        </Section>
      </If>
      <If when={original}>
        <Section title="测试发送">
          <Action
            label={testing() ? "收起测试" : "测试已保存的账号"}
            kind="secondary"
            onPress={() => testing.update((value) => !value)}
            class="self-start"
          />
          <If when={testing()}>
            <Panel>
              <Field
                label="测试标题"
                value={testTitle()}
                onChange={testTitle.set}
              />
              <Field
                label="测试正文"
                value={testBody()}
                onChange={testBody.set}
                multiline
              />
              <Choice
                label="测试格式"
                value={testFormat()}
                items={(channel()?.capabilities.formats ?? ["text"]).map(
                  (value) => ({ value, title: value }),
                )}
                onChange={(value) =>
                  testFormat.set((value ?? "text") as Format)
                }
              />
              <Problem message={test.problem()} />
              <If when={testResult()}>
                <Text class="text-sm text-success">{testResult()}</Text>
              </If>
              <Action
                label={test.busy() ? "正在测试…" : "发送测试通知"}
                kind="primary"
                onPress={testSend}
                disabled={
                  test.busy() ||
                  action.busy() ||
                  !testTitle().trim() ||
                  !testBody().trim()
                }
              />
            </Panel>
          </If>
          <Action
            label="删除账号"
            kind="danger"
            class="self-start"
            onPress={remove}
            disabled={action.busy() || test.busy()}
          />
        </Section>
      </If>
    </WorkspacePage>
  );
}
