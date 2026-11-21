import { signal, Text, View } from "nsh";
import { ApiError, type AnserApi } from "../api";
import type { Channel, JsonObject, Target, Topic } from "../contracts";
import { integer, parseObject, tagsFrom } from "../forms";
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
import { strategyDraft, StrategyEditor, Targets } from "../components/Routing";
import { RecordRow, WorkspacePage } from "../components/Workspace";
import { operation, paged } from "../state";

export function Topics(props: {
  api: AnserApi;
  admin?: boolean;
  onOpen: (topic: Topic) => void;
  onCreate: () => void;
  onDefault: () => void;
}) {
  const list = paged(props.api.topics.bind(props.api));
  return (
    <WorkspacePage title="Topic 与订阅">
      <View class="flex-row flex-wrap justify-between gap-2">
        <View class="flex-row flex-wrap gap-2">
          <Action
            label="刷新"
            onPress={list.reload}
            kind="quiet"
            disabled={list.loading()}
          />
          <If when={props.admin !== false}>
            <Action label="默认路由" onPress={props.onDefault} />
          </If>
        </View>
        <If when={props.admin !== false}>
          <Action label="创建 Topic" onPress={props.onCreate} kind="primary" />
        </If>
      </View>
      <ReadState
        loading={list.loading()}
        problem={list.problem()}
        empty={!list.items().length}
        emptyLabel={
          props.admin === false
            ? "服务器还没有可订阅的 Topic。"
            : "还没有 Topic。创建后即可管理路由和订阅。"
        }
      />
      <Each of={list.items()} key={(topic) => topic.name}>
        {(topic) => (
          <RecordRow
            title={topic().name}
            subtitle={topic().description ?? undefined}
            status={
              <Text
                class={
                  topic().enabled
                    ? "text-sm text-success"
                    : "text-sm text-muted-foreground"
                }
              >
                {topic().enabled ? "已启用" : "已停用"}
              </Text>
            }
            onPress={() => props.onOpen(topic())}
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

export function TopicDetail(props: {
  api: AnserApi;
  topic: Topic;
  username?: string;
  admin?: boolean;
  onBack: () => void;
  onEdit: () => void;
  onPublish: () => void;
}) {
  const topic = props.topic;
  const list = paged((cursor, abort) =>
    props.api.subscriptions(topic.name, cursor, abort),
  );
  const accounts = paged(
    props.admin === false
      ? async () => ({ items: [] })
      : props.api.accounts.bind(props.api),
  );
  const subscribe = operation();
  const unsubscribe = operation();
  const editing = signal(false);
  const subscriber = signal(props.username ?? "");
  const filter = signal("");
  const account = signal("");
  const address = signal("");
  const password = signal("");
  const modeLabels = {
    broadcast: "广播",
    failover: "故障转移",
    weighted: "加权",
    weighted_failover: "加权故障转移",
  };

  function add() {
    void subscribe.run(async () => {
      if (!subscriber().trim())
        throw new ApiError("invalid_subscriber", "请填写订阅者标识。");
      let target: JsonObject | undefined;
      if (address().trim()) {
        if (!account())
          throw new ApiError(
            "missing_account",
            "替换接收目标前请选择渠道账号。",
          );
        target = parseObject(address(), "接收目标");
      }
      await props.api.subscribe(topic.name, {
        subscriber_ref: subscriber().trim(),
        account_id: account() || undefined,
        filter: tagsFrom(filter()),
        target,
        password: password() || undefined,
      });
      if (!subscribe.live()) return;
      subscriber.set(props.username ?? "");
      filter.set("");
      account.set("");
      address.set("");
      password.set("");
      editing.set(false);
      await list.reload();
    });
  }

  function remove(id: string) {
    void unsubscribe.run(async () => {
      if (
        !(await confirm(
          "取消订阅？",
          "该订阅在队列中等待发送的通知会被取消。",
          "退订",
        ))
      )
        return;
      await props.api.unsubscribe(topic.name, id);
      if (unsubscribe.live()) await list.reload();
    });
  }

  return (
    <WorkspacePage title={topic.name} back={props.onBack}>
      <Panel>
        <Text class="text-base font-semibold text-foreground">
          {topic.enabled ? "已启用" : "已停用"} ·{" "}
          {modeLabels[topic.policy.mode]}
          {topic.protected ? " · 需要密码" : ""}
        </Text>
        <If when={topic.description}>
          <Hint>{topic.description}</Hint>
        </If>
        <Hint>{topic.policy.targets.length} 个路由目标</Hint>
        <View class="flex-row flex-wrap gap-2">
          <Action
            label="发布通知"
            onPress={props.onPublish}
            kind="primary"
            disabled={!topic.enabled}
          />
          <If when={props.admin !== false}>
            <Action label="编辑 Topic" onPress={props.onEdit} />
          </If>
        </View>
      </Panel>
      <Section title="订阅">
        <View class="flex-row flex-wrap justify-between gap-2">
          <Action
            label="刷新"
            onPress={list.reload}
            kind="quiet"
            disabled={list.loading()}
          />
          <Action
            label={editing() ? "收起表单" : "添加订阅"}
            onPress={() => editing.update((value) => !value)}
          />
        </View>
        <If when={editing()}>
          <Panel>
            <Problem message={subscribe.problem()} />
            <Field
              label="订阅者标识"
              value={subscriber()}
              onChange={subscriber.set}
            />
            <If when={props.admin !== false}>
              <Choice
                label="专属账号"
                value={account()}
                items={[
                  { value: "", title: "使用 Topic 路由策略" },
                  ...accounts
                    .items()
                    .map((item) => ({
                      value: item.id,
                      title: item.name,
                      disabled: !item.enabled,
                    })),
                ]}
                onChange={(value) => {
                  account.set(value ?? "");
                  address.set("");
                }}
              />
              <If when={accounts.problem()}>
                <Field
                  label="专属账号 ID（可选）"
                  value={account()}
                  onChange={account.set}
                  hint="无法列出账号时，可以输入管理员提供的账号 ID。"
                />
              </If>
              <If when={accounts.next()}>
                <Action
                  label="加载更多账号"
                  class="self-start"
                  kind="quiet"
                  onPress={accounts.more}
                  disabled={accounts.loading()}
                />
              </If>
              <If when={account()}>
                <Field
                  label="接收目标（可选 JSON）"
                  value={address()}
                  onChange={address.set}
                  hint="填写渠道支持的目标字段。留空时使用该账号已保存的接收目标。"
                />
              </If>
            </If>
            <If when={topic.protected}>
              <Field
                label="Topic 密码"
                masked
                value={password()}
                onChange={password.set}
              />
            </If>
            <Field
              label="匹配消息标签"
              value={filter()}
              onChange={filter.set}
              hint="多个标签用逗号分隔。"
            />
            <Action
              label={subscribe.busy() ? "正在保存…" : "保存订阅"}
              onPress={add}
              kind="primary"
              disabled={subscribe.busy() || !subscriber().trim()}
            />
          </Panel>
        </If>
        <Problem message={unsubscribe.problem()} />
        <ReadState
          loading={list.loading()}
          problem={list.problem()}
          empty={!list.items().length}
          emptyLabel="这个 Topic 还没有订阅者。"
        />
        <Each of={list.items()} key={(entry) => entry.id}>
          {(entry) => (
            <RecordRow
              title={entry().subscriber_ref}
              subtitle={[
                accounts.items().find((item) => item.id === entry().account_id)
                  ?.name ??
                  entry().account_id ??
                  "使用 Topic 路由",
                ...(entry().filter ?? []),
              ].join(" / ")}
              status={
                <Action
                  label="退订"
                  kind="quiet"
                  disabled={unsubscribe.busy()}
                  onPress={() => remove(entry().id)}
                />
              }
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
      </Section>
    </WorkspacePage>
  );
}

export function TopicEditor(props: {
  api: AnserApi;
  channels: Channel[];
  topic?: Topic;
  onBack: () => void;
  onSaved: (topic: Topic) => void;
  onDeleted: () => void;
}) {
  const original = props.topic;
  const name = signal(original?.name ?? "");
  const description = signal(original?.description ?? "");
  const enabled = signal(original?.enabled ?? true);
  const protect = signal(original?.protected ?? false);
  const defaultTags = signal((original?.default_tags ?? []).join(", "));
  const retention = signal(
    original?.retention == null ? "" : String(original.retention),
  );
  const password = signal("");
  const targets = signal<Target[]>(original?.policy.targets ?? []);
  const strategy = strategyDraft(
    original?.policy ?? { mode: "broadcast", success_criteria: "all" },
  );
  const accounts = paged(props.api.accounts.bind(props.api));
  const action = operation();

  function save() {
    void action.run(async () => {
      const topic = name().trim();
      if (
        topic === "." ||
        topic === ".." ||
        !/^[A-Za-z0-9._-]{1,128}$/.test(topic)
      )
        throw new ApiError(
          "invalid_topic",
          "Topic 名称只能包含字母、数字、点、下划线和连字符。",
        );
      if (protect() && !original?.protected && !password())
        throw new ApiError("missing_topic_password", "请设置 Topic 密码。");
      const policy = strategy.value();
      const request = {
        name: topic,
        description: description().trim(),
        enabled: enabled(),
        default_tags: tagsFrom(defaultTags()),
        retention: retention().trim()
          ? integer(retention(), "记录保留期", 1, 3650)
          : null,
        password: protect()
          ? password() || undefined
          : original?.protected
            ? null
            : undefined,
        policy: {
          ...policy,
          mode: policy.mode ?? ("broadcast" as const),
          targets: targets(),
        },
      };
      const saved = await props.api.saveTopic(original?.name, request);
      if (action.live()) props.onSaved(saved);
    });
  }

  function remove() {
    void action.run(async () => {
      if (
        !original ||
        !(await confirm(
          "删除 Topic？",
          "该 Topic 将无法接收新发布。",
          "删除 Topic",
        ))
      )
        return;
      await props.api.deleteTopic(original.name);
      if (action.live()) props.onDeleted();
    });
  }

  return (
    <WorkspacePage
      title={original ? "编辑 Topic" : "创建 Topic"}
      back={props.onBack}
      footer={
        <View class="flex-row flex-wrap gap-2">
          <Action
            label={action.busy() ? "正在保存…" : "保存 Topic"}
            onPress={save}
            kind="primary"
            disabled={action.busy() || !name().trim()}
          />
          <Action
            label="取消"
            onPress={props.onBack}
            kind="quiet"
            disabled={action.busy()}
          />
        </View>
      }
    >
      <Problem message={action.problem()} />
      <Panel>
        <Field
          label="Topic 名称"
          value={name()}
          onChange={name.set}
          disabled={Boolean(original)}
          hint="可使用字母、数字、点、下划线和连字符。"
        />
        <Field
          label="描述"
          value={description()}
          onChange={description.set}
          multiline
        />
        <Field
          label="默认消息标签"
          value={defaultTags()}
          onChange={defaultTags.set}
          hint="多个标签用逗号分隔。"
        />
        <Field
          label="记录保留期（天）"
          value={retention()}
          onChange={retention.set}
          keyboard="numeric"
          hint="留空使用服务器默认设置。"
        />
        <Toggle label="启用 Topic" checked={enabled()} onChange={enabled.set} />
        <Toggle
          label="启用密码保护"
          checked={protect()}
          onChange={protect.set}
        />
        <If when={protect()}>
          <Field
            label="Topic 密码"
            masked
            value={password()}
            onChange={password.set}
            hint={
              original?.protected
                ? "留空将沿用现有密码。"
                : "未获授权的订阅或发布可能需要此密码。"
            }
          />
        </If>
      </Panel>
      <Targets
        targets={targets()}
        onChange={targets.set}
        channels={props.channels}
        accounts={accounts.items()}
        title="路由目标"
        allowOverrides
        emptyLabel="未指定显式目标。发送时按可用账号和订阅规则投递。"
      />
      <If when={accounts.next()}>
        <Action
          label="加载更多账号"
          class="self-start"
          kind="quiet"
          disabled={accounts.loading()}
          onPress={accounts.more}
        />
      </If>
      <Section title="路由策略">
        <Panel>
          <StrategyEditor draft={strategy} />
        </Panel>
      </Section>
      <If when={original}>
        <Action
          label="删除 Topic"
          onPress={remove}
          kind="danger"
          class="self-start"
          disabled={action.busy()}
        />
      </If>
    </WorkspacePage>
  );
}
