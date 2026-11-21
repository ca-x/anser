import { t } from "nsh/i18n";
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
    <WorkspacePage title={t("accounts.channel_accounts")}>
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
        />
      </View>
      <ReadState
        loading={list.loading()}
        problem={list.problem()}
        empty={!list.items().length}
        emptyLabel={t("accounts.no_channel_accounts_add_one_to")}
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
            disabled={action.busy() || test.busy()}
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
            title: entry.display_name,
          }))}
          disabled={Boolean(original)}
          onChange={(value) => {
            channelId.set(value ?? "");
            config.clear();
          }}
        />
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
      <If when={channelId()}>
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
