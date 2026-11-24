import { t } from "nsh/i18n";
import { effect, signal, Text, View } from "nsh";
import { ApiError, type AnserApi } from "../api";
import { channelName } from "../channelNames";
import type {
  Account,
  Channel,
  Format,
  JsonObject,
  LazycatTarget,
} from "../contracts";
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
import {
  channelConfigDraft,
  ChannelConfig,
  supportsProxy,
  usesDevicePicker,
} from "../components/ChannelConfig";
import { RecordRow, WorkspacePage } from "../components/Workspace";
import { operation, paged } from "../state";
import { LazycatDevicePicker, serializeDeviceTarget } from "../components/LazycatDevicePicker";
import { ProxyPicker } from "./Proxies";

export function Accounts(props: {
  api: AnserApi;
  channels: Channel[];
  revision: number;
  onPlugins?: () => void;
  onProxies?: () => void;
  onOpen: (account: Account) => void;
  onCreate: () => void;
}) {
  return (
    <WorkspacePage title={t("accounts.channel_accounts")}>
      <If when={props.onPlugins || props.onProxies}>
        <View class="flex-row flex-wrap gap-2">
          <If when={props.onPlugins}>
            <Action
              label={t("plugins.title")}
              onPress={() => props.onPlugins?.()}
            />
          </If>
          <If when={props.onProxies}>
            <Action
              label={t("proxies.title")}
              onPress={() => props.onProxies?.()}
            />
          </If>
        </View>
      </If>
      <AccountList
        api={props.api}
        channels={props.channels}
        revision={props.revision}
        onOpen={props.onOpen}
        onCreate={props.onCreate}
      />
    </WorkspacePage>
  );
}

export function AccountList(props: {
  api: AnserApi;
  channels: Channel[];
  channel?: Channel;
  revision: number;
  onOpen: (account: Account) => void;
  onCreate: () => void;
}) {
  const list = paged((cursor, abort) =>
    props.api.accounts(cursor, abort, props.channel?.id),
  );
  const items = () =>
    list
      .items()
      .filter(
        (account) => !props.channel || account.channel === props.channel.id,
      );
  let revision = props.revision;
  effect(() => {
    const next = props.revision;
    if (next !== revision) {
      revision = next;
      void list.reload();
    }
  });
  return (
    <>
      <View class="flex-row flex-wrap justify-between gap-2">
        <Action
          label={t("common.refresh")}
          kind="quiet"
          onPress={list.reload}
          disabled={list.loading()}
        />
        <Action
          label={t("accounts.add_account")}
          kind="primary"
          onPress={props.onCreate}
          disabled={props.channel?.available === false}
        />
      </View>
      <ReadState
        loading={list.loading()}
        problem={list.problem()}
        empty={!items().length && !list.next()}
        emptyLabel={t(
          props.channel
            ? "plugins.no_accounts"
            : "accounts.no_channel_accounts_add_one_to",
        )}
      />
      <Each of={items()} key={(account) => account.id}>
        {(account) => (
          <RecordRow
            title={account().name}
            subtitle={[
              ...(props.channel
                ? []
                : [
                    channelName(
                      account().channel,
                      props.channels.find(
                        (channel) => channel.id === account().channel,
                      )?.display_name,
                    ),
                  ]),
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
                {account().enabled ? t("common.enabled") : t("common.disabled")}
              </Text>
            }
            onPress={() => props.onOpen(account())}
          />
        )}
      </Each>
      <If when={list.next()}>
        <Action
          label={t("common.load_more")}
          onPress={list.more}
          disabled={list.loading()}
        />
      </If>
    </>
  );
}

export function AccountEditor(props: {
  api: AnserApi;
  channels: Channel[];
  account?: Account;
  presetChannel?: string;
  canManageProxies: boolean;
  onBack: () => void;
  onSaved: (account: Account) => void;
  onDeleted: () => void;
}) {
  const original = props.account;
  const name = signal(original?.name ?? "");
  const channelId = signal(original?.channel ?? props.presetChannel ?? "");
  const channel = () =>
    props.channels.find((entry) => entry.id === channelId());
  const proxyId = signal<string | null | undefined>(
    original?.proxy_id ?? (original ? undefined : null),
  );
  const proxySupported = () => supportsProxy(channel());
  const devicePicker = () => usesDevicePicker(channel());
  const tags = signal((original?.tags ?? []).join(", "));
  const weight = signal(String(original?.weight ?? 1));
  const priority = signal(String(original?.priority ?? 0));
  const limit = signal(
    original?.rate_limit == null ? "" : String(original.rate_limit),
  );
  const enabled = signal(original?.enabled ?? true);
  const replaceConfig = signal(!original);
  const device = signal<LazycatTarget | undefined>(undefined);
  const deviceAvailable = signal(false);
  const config = channelConfigDraft(channel);
  const action = operation();
  const test = operation();
  const testing = signal(false);
  const testTitle = signal(t("accounts.anser_test"));
  const testBody = signal(t("accounts.this_is_a_test_notification_from"));
  const testFormat = signal<Format>("text");
  const testResult = signal("");

  function save() {
    void action.run(async () => {
      if (!name().trim() || !channelId())
        throw new ApiError(
          "invalid_account",
          t("accounts.enter_an_account_name_and_select"),
        );
      const data: JsonObject = {
        name: name().trim(),
        tags: tagsFrom(tags()),
        weight: integer(weight(), t("accounts.weight"), 0, 4294967295),
        priority: integer(
          priority(),
          t("accounts.priority"),
          -2147483648,
          2147483647,
        ),
        rate_limit: limit().trim()
          ? integer(limit(), t("accounts.rate_limit_per_minute"), 1, 60000)
          : null,
        enabled: enabled(),
      };
      if (!original) data.channel = channelId();
      if (proxySupported()) {
        const selected = proxyId();
        if (original) {
          data.inline_proxy = selected === null ? "clear" : "keep";
          if (
            selected === null ||
            (selected !== undefined && selected !== original.proxy_id)
          )
            data.proxy_id = selected;
        } else if (selected) {
          data.proxy_id = selected;
        }
      }
      if (replaceConfig()) {
        if (devicePicker()) {
          const target = device();
          if (!target || !deviceAvailable())
            throw new ApiError("missing_device", t("devices.choose"));
          data.config = serializeDeviceTarget(target);
        } else {
          data.config = config.value();
        }
      }
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
          t("accounts.delete_account"),
          t("accounts.the_account_will_no_longer_be"),
          t("accounts.delete_account_2"),
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
          ? t("accounts.the_channel_accepted_the_request_and")
          : t("accounts.the_channel_accepted_the_test_notification"),
      );
    });
  }

  return (
    <WorkspacePage
      title={original ? t("accounts.edit_account") : t("accounts.add_account")}
      back={props.onBack}
      footer={
        <View class="flex-row flex-wrap gap-2">
          <Action
            label={
              action.busy() ? t("common.saving") : t("accounts.save_account")
            }
            kind="primary"
            onPress={save}
            disabled={
              action.busy() ||
              test.busy() ||
              (replaceConfig() &&
                devicePicker() &&
                !deviceAvailable())
            }
          />
          <Action
            label={t("common.cancel")}
            kind="quiet"
            onPress={props.onBack}
            disabled={action.busy() || test.busy()}
          />
        </View>
      }
    >
      <Problem message={action.problem()} />
      <Panel>
        <Field
          label={t("accounts.account_name")}
          value={name()}
          onChange={name.set}
        />
        <Choice
          label={t("common.channel")}
          value={channelId() || null}
          items={props.channels.map((entry) => ({
            value: entry.id,
            title: channelName(entry.id, entry.display_name),
          }))}
          disabled={Boolean(original || props.presetChannel)}
          onChange={(value) => {
            channelId.set(value ?? "");
            proxyId.set(null);
            config.clear();
            device.set(undefined);
          }}
        />
        <If when={devicePicker()}>
          <If when={original}>
            <Toggle
              label={t("devices.change")}
              checked={replaceConfig()}
              onChange={(value) => {
                replaceConfig.set(value);
                if (!value) device.set(undefined);
              }}
            />
          </If>
          <If
            when={replaceConfig()}
            else={<Hint>{t("devices.keep_existing")}</Hint>}
          >
            <LazycatDevicePicker
              api={props.api}
              accountId={original?.id}
              selected={device()}
              onChange={device.set}
              onAvailable={deviceAvailable.set}
            />
          </If>
        </If>
        <If when={props.canManageProxies && proxySupported()}>
          <ProxyPicker
            api={props.api}
            selected={proxyId()}
            canKeepExisting={Boolean(original && !original.proxy_id)}
            onChange={proxyId.set}
          />
        </If>
        <Field
          label={t("accounts.tags")}
          value={tags()}
          onChange={tags.set}
          hint={t("common.separate_multiple_tags_with_commas")}
        />
        <View class="gap-3 md:flex-row">
          <View class="flex-1">
            <Field
              label={t("accounts.weight")}
              value={weight()}
              onChange={weight.set}
              keyboard="numeric"
              hint={t("accounts.a_weight_of_0_marks_a")}
            />
          </View>
          <View class="flex-1">
            <Field
              label={t("accounts.priority")}
              value={priority()}
              onChange={priority.set}
              keyboard="numeric"
              hint={t("accounts.lower_values_are_tried_first")}
            />
          </View>
          <View class="flex-1">
            <Field
              label={t("accounts.rate_limit_per_minute")}
              value={limit()}
              onChange={limit.set}
              keyboard="numeric"
            />
          </View>
        </View>
        <Toggle
          label={t("accounts.enable_account")}
          checked={enabled()}
          onChange={enabled.set}
        />
      </Panel>
      <If when={channelId() && !devicePicker()}>
        <Section title={t("common.channel_configuration")}>
          <If when={original}>
            <Toggle
              label={t("accounts.replace_saved_configuration")}
              checked={replaceConfig()}
              onChange={(value) => {
                replaceConfig.set(value);
                if (!value) config.clear();
              }}
            />
            <Hint>{t("accounts.saved_credentials_are_hidden_enter_the")}</Hint>
          </If>
          <If when={replaceConfig()}>
            <ChannelConfig draft={config} />
          </If>
        </Section>
      </If>
      <If when={original}>
        <Section title={t("accounts.test_delivery")}>
          <Action
            label={
              testing()
                ? t("accounts.hide_test")
                : t("accounts.test_saved_account")
            }
            kind="secondary"
            onPress={() => testing.update((value) => !value)}
            class="self-start"
          />
          <If when={testing()}>
            <Panel>
              <Field
                label={t("accounts.test_title")}
                value={testTitle()}
                onChange={testTitle.set}
              />
              <Field
                label={t("accounts.test_body")}
                value={testBody()}
                onChange={testBody.set}
                multiline
              />
              <Choice
                label={t("accounts.test_format")}
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
                label={
                  test.busy()
                    ? t("accounts.testing")
                    : t("accounts.send_test_notification")
                }
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
            label={t("accounts.delete_account_2")}
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
