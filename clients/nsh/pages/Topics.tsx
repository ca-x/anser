import { t } from "nsh/i18n";
import { signal, Text, View } from "nsh";
import { ApiError, type AnserApi } from "../api";
import type {
  Channel,
  JsonObject,
  LazycatTarget,
  Target,
  Topic,
} from "../contracts";
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
import { LazycatDevicePicker } from "../components/LazycatDevicePicker";
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
    <WorkspacePage title={t("topics.topics_and_subscriptions")}>
      <View class="flex-row flex-wrap justify-between gap-2">
        <View class="flex-row flex-wrap gap-2">
          <Action
            label={t("common.refresh")}
            onPress={list.reload}
            kind="quiet"
            disabled={list.loading()}
          />
          <If when={props.admin !== false}>
            <Action
              label={t("common.default_routing")}
              onPress={props.onDefault}
            />
          </If>
        </View>
        <If when={props.admin !== false}>
          <Action
            label={t("topics.create_topic")}
            onPress={props.onCreate}
            kind="primary"
          />
        </If>
      </View>
      <ReadState
        loading={list.loading()}
        problem={list.problem()}
        empty={!list.items().length}
        emptyLabel={
          props.admin === false
            ? t("topics.no_topics_available_to_subscribe_to")
            : t("topics.no_topics_yet_create_one_to")
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
                {topic().enabled ? t("common.enabled") : t("common.disabled")}
              </Text>
            }
            onPress={() => props.onOpen(topic())}
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
  const device = signal<LazycatTarget | undefined>(undefined);
  const deviceAvailable = signal(false);
  const selectedAccount = () =>
    accounts.items().find((item) => item.id === account());
  const password = signal("");
  const modeLabel = () =>
    ({
      broadcast: t("topics.broadcast"),
      failover: t("topics.failover"),
      weighted: t("topics.weighted"),
      weighted_failover: t("topics.weighted_failover"),
    })[topic.policy.mode];

  function chooseAccount(id: string | null) {
    account.set(id ?? "");
    address.set("");
    device.set(undefined);
  }

  function add() {
    void subscribe.run(async () => {
      if (!subscriber().trim())
        throw new ApiError(
          "invalid_subscriber",
          t("topics.enter_a_subscriber_identifier"),
        );
      let target: JsonObject | undefined;
      if (selectedAccount()?.channel === "lazycat") {
        const selected = device();
        if (selected) {
          if (!deviceAvailable())
            throw new ApiError("missing_device", t("devices.choose"));
          target = { ...selected };
        }
      } else if (address().trim() && selectedAccount()) {
        target = parseObject(address(), t("topics.recipient_override"));
        if ("proxy" in target)
          throw new ApiError("invalid_recipient", t("proxies.choose_profile"));
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
      device.set(undefined);
      password.set("");
      editing.set(false);
      await list.reload();
    });
  }

  function remove(id: string) {
    void unsubscribe.run(async () => {
      if (
        !(await confirm(
          t("topics.unsubscribe"),
          t("topics.queued_notifications_for_this_subscription_will"),
          t("topics.unsubscribe_2"),
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
          {topic.enabled ? t("common.enabled") : t("common.disabled")} ·{" "}
          {modeLabel()}
          {topic.protected ? t("topics.protected_suffix") : ""}
        </Text>
        <If when={topic.description}>
          <Hint>{topic.description}</Hint>
        </If>
        <Hint>
          {t("topics.target_count", { count: topic.policy.targets.length })}
        </Hint>
        <View class="flex-row flex-wrap gap-2">
          <Action
            label={t("topics.publish_notification")}
            onPress={props.onPublish}
            kind="primary"
            disabled={!topic.enabled}
          />
          <If when={props.admin !== false}>
            <Action label={t("topics.edit_topic")} onPress={props.onEdit} />
          </If>
        </View>
      </Panel>
      <Section title={t("topics.subscriptions")}>
        <View class="flex-row flex-wrap justify-between gap-2">
          <Action
            label={t("common.refresh")}
            onPress={list.reload}
            kind="quiet"
            disabled={list.loading()}
          />
          <Action
            label={
              editing() ? t("topics.hide_form") : t("topics.add_subscription")
            }
            onPress={() => editing.update((value) => !value)}
          />
        </View>
        <If when={editing()}>
          <Panel>
            <Problem message={subscribe.problem()} />
            <Field
              label={t("topics.subscriber_identifier")}
              value={subscriber()}
              onChange={subscriber.set}
            />
            <If when={props.admin !== false}>
              <Choice
                label={t("topics.dedicated_account")}
                value={account()}
                items={[
                  {
                    value: "",
                    title: t("topics.use_the_topic_routing_policy"),
                  },
                  ...accounts.items().map((item) => ({
                    value: item.id,
                    title: item.name,
                    disabled: !item.enabled,
                  })),
                ]}
                onChange={chooseAccount}
              />
              <If when={accounts.problem()}>
                <Field
                  label={t("topics.dedicated_account_id_optional")}
                  value={account()}
                  onChange={chooseAccount}
                  hint={t("topics.if_accounts_are_unavailable_enter_an")}
                />
                <Action
                  label={t("common.refresh")}
                  kind="quiet"
                  class="self-start"
                  disabled={accounts.loading()}
                  onPress={accounts.reload}
                />
              </If>
              <If when={accounts.next()}>
                <Action
                  label={t("common.load_more_accounts")}
                  class="self-start"
                  kind="quiet"
                  onPress={accounts.more}
                  disabled={accounts.loading()}
                />
              </If>
              <If
                when={selectedAccount()?.channel === "lazycat"}
                else={
                  <If when={selectedAccount()}>
                    <Field
                      label={t("topics.recipient_override_optional_json")}
                      value={address()}
                      onChange={address.set}
                      hint={t("topics.enter_the_fields_supported_by_this")}
                    />
                  </If>
                }
              >
                <LazycatDevicePicker
                  api={props.api}
                  useAccountDevice
                  selected={device()}
                  onChange={device.set}
                  onAvailable={deviceAvailable.set}
                />
              </If>
            </If>
            <If when={topic.protected}>
              <Field
                label={t("topics.topic_password")}
                masked
                value={password()}
                onChange={password.set}
              />
            </If>
            <Field
              label={t("topics.match_message_tags")}
              value={filter()}
              onChange={filter.set}
              hint={t("common.separate_multiple_tags_with_commas")}
            />
            <Action
              label={
                subscribe.busy()
                  ? t("common.saving")
                  : t("topics.save_subscription")
              }
              onPress={add}
              kind="primary"
              disabled={
                subscribe.busy() ||
                !subscriber().trim() ||
                Boolean(
                  selectedAccount()?.channel === "lazycat" &&
                    device() &&
                    !deviceAvailable(),
                )
              }
            />
          </Panel>
        </If>
        <Problem message={unsubscribe.problem()} />
        <ReadState
          loading={list.loading()}
          problem={list.problem()}
          empty={!list.items().length}
          emptyLabel={t("topics.this_topic_has_no_subscribers")}
        />
        <Each of={list.items()} key={(entry) => entry.id}>
          {(entry) => (
            <RecordRow
              title={entry().subscriber_ref}
              subtitle={[
                accounts.items().find((item) => item.id === entry().account_id)
                  ?.name ??
                  entry().account_id ??
                  t("topics.use_topic_routing"),
                ...(entry().filter ?? []),
              ].join(" / ")}
              status={
                <Action
                  label={t("topics.unsubscribe_2")}
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
            label={t("common.load_more")}
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
          t("topics.a_topic_name_can_include_letters"),
        );
      if (protect() && !original?.protected && !password())
        throw new ApiError(
          "missing_topic_password",
          t("topics.set_a_topic_password"),
        );
      const policy = strategy.value();
      const request = {
        name: topic,
        description: description().trim(),
        enabled: enabled(),
        default_tags: tagsFrom(defaultTags()),
        retention: retention().trim()
          ? integer(retention(), t("topics.history_retention"), 1, 3650)
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
          t("topics.delete_topic"),
          t("topics.the_topic_will_stop_accepting_new"),
          t("topics.delete_topic_2"),
        ))
      )
        return;
      await props.api.deleteTopic(original.name);
      if (action.live()) props.onDeleted();
    });
  }

  return (
    <WorkspacePage
      title={original ? t("topics.edit_topic") : t("topics.create_topic")}
      back={props.onBack}
      footer={
        <View class="flex-row flex-wrap gap-2">
          <Action
            label={action.busy() ? t("common.saving") : t("topics.save_topic")}
            onPress={save}
            kind="primary"
            disabled={action.busy() || !name().trim()}
          />
          <Action
            label={t("common.cancel")}
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
          label={t("topics.topic_name")}
          value={name()}
          onChange={name.set}
          disabled={Boolean(original)}
          hint={t("topics.use_letters_numbers_periods_underscores_and")}
        />
        <Field
          label={t("topics.description")}
          value={description()}
          onChange={description.set}
          multiline
        />
        <Field
          label={t("topics.default_message_tags")}
          value={defaultTags()}
          onChange={defaultTags.set}
          hint={t("common.separate_multiple_tags_with_commas")}
        />
        <Field
          label={t("topics.history_retention_days")}
          value={retention()}
          onChange={retention.set}
          keyboard="numeric"
          hint={t("topics.leave_blank_to_use_server_defaults")}
        />
        <Toggle
          label={t("topics.enable_topic")}
          checked={enabled()}
          onChange={enabled.set}
        />
        <Toggle
          label={t("topics.require_a_password")}
          checked={protect()}
          onChange={protect.set}
        />
        <If when={protect()}>
          <Field
            label={t("topics.topic_password")}
            masked
            value={password()}
            onChange={password.set}
            hint={
              original?.protected
                ? t("topics.leave_blank_to_keep_the_existing")
                : t("topics.users_may_need_this_password_to")
            }
          />
        </If>
      </Panel>
      <Targets
        targets={targets()}
        onChange={targets.set}
        channels={props.channels}
        accounts={accounts.items()}
        title={t("topics.routing_targets_2")}
        allowOverrides
        emptyLabel={t("topics.no_targets_specified_delivery_will_use")}
      />
      <If when={accounts.next()}>
        <Action
          label={t("common.load_more_accounts")}
          class="self-start"
          kind="quiet"
          disabled={accounts.loading()}
          onPress={accounts.more}
        />
      </If>
      <Section title={t("common.routing_policy")}>
        <Panel>
          <StrategyEditor draft={strategy} />
        </Panel>
      </Section>
      <If when={original}>
        <Action
          label={t("topics.delete_topic_2")}
          onPress={remove}
          kind="danger"
          class="self-start"
          disabled={action.busy()}
        />
      </If>
    </WorkspacePage>
  );
}
