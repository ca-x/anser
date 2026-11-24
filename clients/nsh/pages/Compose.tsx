import { t } from "nsh/i18n";
import { announce, cleanup, effect, resource, signal, Text, View } from "nsh";
import { ApiError, messageFor, type AnserApi } from "../api";
import type { Acceptance, Account, Channel, Format, Publish, Target, Topic } from "../contracts";
import { integer, optionalHttpUrl, parseObject, tagsFrom } from "../forms";
import {
  Action,
  Choice,
  Field,
  Hint,
  Panel,
  Problem,
  Section,
  Toggle,
} from "../components/Controls";
import { strategyDraft, StrategyEditor } from "../components/Routing";
import { DeliveryStatus } from "../components/DeliveryStatus";
import { WorkspacePage } from "../components/Workspace";
import { SelectionTags, ServerTags } from "../components/ServerProfiles";
import { toggleOrigin, type Servers } from "../servers";
import { channelName } from "../channelNames";
import { paged } from "../state";

const formats = () => [
  { value: "text", title: t("common.plain_text") },
  { value: "markdown", title: "Markdown" },
  { value: "html", title: "HTML" },
];

type SendResult =
  | { origin: string; receipt: Acceptance; error?: never }
  | { origin: string; error: string; receipt?: never };

export function composeDraft(initialTopic = "") {
  const topic = signal(initialTopic);
  const title = signal("");
  const body = signal("");
  const format = signal<Format>("text");
  const speech = signal(false);
  const targets = signal<Target[]>([]);
  const tags = signal("");
  const link = signal("");
  const level = signal("info");
  const topicPassword = signal("");
  const needsTopicPassword = signal(false);
  const attachment = signal("");
  const attachmentName = signal("");
  const attachmentType = signal("");
  const extras = signal("");
  const expiresIn = signal("");
  const callback = signal("");
  const wait = signal(false);
  const advanced = signal(false);
  const strategy = strategyDraft();
  const busy = signal(false);
  const problem = signal("");
  const receipt = signal<string | undefined>(undefined);
  const servers = signal<string[] | undefined>(undefined);
  const results = signal<SendResult[]>([]);
  let pending: {
    request: string;
    key: string;
    expiry?: number;
    accepted: Map<string, Acceptance>;
    uncertain: Map<string, symbol>;
  } | undefined;

  const canSubmit = () => !busy() && Boolean(title().trim() || body().trim());

  async function submit(apis: AnserApi[], local: boolean, label: (origin: string) => string) {
    if (!canSubmit() || !apis.length) return;
    busy.set(true);
    problem.set("");
    try {
      const next: Publish = {
        title: title().trim(),
        body: body(),
        format: format(),
      };
      if (speech()) next.speech = true;
      if (local && targets().length) next.channels = targets();
      const messageTags = tagsFrom(tags());
      if (messageTags.length) next.tags = messageTags;
      next.url = optionalHttpUrl(link(), t("compose.notification_link"));
      next.level = level();
      const destination = local ? topic() || undefined : undefined;
      if (destination && topicPassword()) next.topic_password = topicPassword();
      const file = optionalHttpUrl(attachment(), t("compose.attachment_url"));
      if (file)
        next.attachments = [
          {
            url: file,
            name: attachmentName().trim() || undefined,
            content_type: attachmentType().trim() || undefined,
          },
        ];
      if (extras().trim())
        next.extras = parseObject(extras(), t("compose.extra_fields"));
      if (callback().trim())
        next.callback_url = optionalHttpUrl(
          callback(),
          t("compose.callback_url"),
        );
      // Preserve both the idempotency key and the original absolute expiry when a timed-out request is retried.
      const expirySeconds = expiresIn().trim()
        ? integer(expiresIn(), t("compose.expiration"), 1, 604800)
        : undefined;
      if (local) {
        const requestedStrategy = strategy.value();
        if (Object.keys(requestedStrategy).length) next.strategy = requestedStrategy;
      }
      // A changed Topic password still addresses the same logical delivery.
      const request = JSON.stringify([destination, { ...next, topic_password: undefined }, expirySeconds]);
      if (!pending || pending.request !== request) {
        pending = {
          request,
          key: crypto.randomUUID(),
          accepted: new Map(),
          uncertain: new Map(),
          expiry:
            expirySeconds === undefined
              ? undefined
              : Date.now() + expirySeconds * 1000,
        };
      }
      const batch = pending;
      next.expire_at = batch.expiry;
      const waitForResult = wait();
      if (next.speech) {
        const checks = await Promise.all(apis.filter((api) => !batch.accepted.has(api.origin)).map(async (api) => {
          try {
            const info = await api.info();
            if (info.features?.speech_publish !== true)
              return t("speech.server_unsupported", { server: label(api.origin) });
            const channels = await api.channels();
            if (!channels.some((channel) => channel.can_manage === true))
              return t("speech.server_unsupported", { server: label(api.origin) });
          } catch (error) {
            if (error instanceof ApiError && error.status === 404)
              return t("speech.server_unsupported", { server: label(api.origin) });
            return t("speech.server_check_failed", { server: label(api.origin), reason: messageFor(error) });
          }
        }));
        const failure = checks.find(Boolean);
        if (failure) {
          problem.set(failure);
          return;
        }
      }
      const outcomes = await Promise.all(apis.map(async (api): Promise<SendResult> => {
        const previous = batch.accepted.get(api.origin);
        if (previous) return { origin: api.origin, receipt: previous };
        const uncertain = batch.uncertain.get(api.origin);
        if (uncertain && uncertain !== api.credentialSession)
          return { origin: api.origin, error: t("compose.receipt_unknown_after_sign_in") };
        try {
          const accepted = await api.publish(destination, next, batch.key, waitForResult);
          batch.accepted.set(api.origin, accepted);
          batch.uncertain.delete(api.origin);
          return { origin: api.origin, receipt: accepted };
        } catch (error) {
          if (local && error instanceof ApiError &&
            (error.code === "topic_password_required" || error.code === "invalid_topic_password"))
            needsTopicPassword.set(true);
          if (!(error instanceof ApiError) ||
            (error.code !== "network_denied" && (error.status === undefined || error.status >= 500)))
            batch.uncertain.set(api.origin, api.credentialSession);
          return { origin: api.origin, error: messageFor(error) };
        }
      }));
      results.set(local ? [] : outcomes);
      const failed = outcomes.find((result) => result.error);
      if (failed) {
        if (local) problem.set(failed.error ?? "");
        return;
      }
      pending = undefined;
      title.set("");
      body.set("");
      topicPassword.set("");
      needsTopicPassword.set(false);
      servers.set(undefined);
      const id = local ? outcomes[0]?.receipt?.message_id : undefined;
      receipt.set(id);
      return id;
    } catch (error) {
      problem.set(messageFor(error));
    } finally {
      busy.set(false);
    }
  }

  return {
    topic,
    title,
    body,
    format,
    speech,
    targets,
    tags,
    link,
    level,
    topicPassword,
    needsTopicPassword,
    attachment,
    attachmentName,
    attachmentType,
    extras,
    expiresIn,
    callback,
    wait,
    advanced,
    strategy,
    busy,
    problem,
    receipt,
    servers,
    results,
    canSubmit,
    submit,
  };
}

export function Compose(props: {
  api: AnserApi;
  channels: Channel[];
  canManageTargets: boolean;
  onManageChannels: () => void;
  fixedTopic?: Topic;
  draft: ReturnType<typeof composeDraft>;
  servers: Servers;
  connections: AnserApi[];
  onConnectServer: (origin: string) => void;
  onManageServers: () => void;
  onBack?: () => void;
  onAccepted: (id: string) => void;
  onServerDelivery?: (origin: string, id: string) => void;
}) {
  const accounts = paged((cursor, abort) => props.canManageTargets
    ? props.api.accounts(cursor, abort)
    : Promise.resolve({ items: [], next_cursor: null }));
  let hadAccountAccess = props.canManageTargets;
  effect(() => {
    const canManage = props.canManageTargets;
    if (canManage && !hadAccountAccess) void accounts.reload();
    hadAccountAccess = canManage;
  });
  const topics = props.fixedTopic
    ? undefined
    : paged(props.api.topics.bind(props.api));
  const {
    topic,
    title,
    body,
    format,
    speech,
    targets,
    tags,
    link,
    level,
    topicPassword,
    needsTopicPassword,
    attachment,
    attachmentName,
    attachmentType,
    extras,
    expiresIn,
    callback,
    wait,
    advanced,
    strategy,
    busy,
    problem,
    receipt,
    canSubmit,
    submit,
  } = props.draft;
  const configured = () => props.servers.defaults();
  const selected = () => (props.draft.servers() ?? (configured().length ? configured() : [props.api.origin]))
    .filter((origin) => origin === props.api.origin || props.servers.items().some((item) => item.origin === origin));
  const local = () => Boolean(topic() || props.fixedTopic) ||
    (selected().length === 1 && selected()[0] === props.api.origin);
  const destinations = () => topic() || props.fixedTopic ? [props.api.origin] : selected();
  const askedAccounts = () => local() && props.canManageTargets && !accounts.loading()
    ? targets().flatMap(({ account_id }) => account_id &&
      !accounts.items().some((account) => account.id === account_id) ? [account_id] : []).join(",") || undefined
    : undefined;
  const resolvedAccounts = resource(askedAccounts, async (requested, { signal }) => {
    const items = await Promise.all(requested.split(",").map((id) => props.api.account(id, signal).catch((error) => {
      if (error instanceof ApiError && error.status === 404) return undefined;
      throw error;
    })));
    return { requested, items: items.filter((account): account is Account => account !== undefined) };
  });
  const configuredAccounts = () => {
    const loaded = resolvedAccounts();
    const extra = loaded && loaded.requested === askedAccounts() ? loaded.items : [];
    return [...accounts.items(), ...extra].flatMap((account) => {
      const channel = props.channels.find((item) => item.id === account.channel);
      if (!account.enabled || !channel || channel.available === false || channel.enabled === false) return [];
      return [{ id: account.id, label: `${account.name} · ${channelName(channel.id, channel.display_name)}` }];
    });
  };
  const checkingTargets = () => local() && targets().length > 0 && props.canManageTargets &&
    (accounts.loading() || (Boolean(askedAccounts()) && resolvedAccounts.state() !== "errored" &&
      resolvedAccounts()?.requested !== askedAccounts()));
  const targetReadProblem = () => local() && targets().length > 0 &&
    askedAccounts() && resolvedAccounts.error() ? messageFor(resolvedAccounts.error()) : "";
  const staleTargets = () => local() && !checkingTargets() && !targetReadProblem() &&
    targets().some((target) => !props.canManageTargets ||
      !configuredAccounts().some((account) => account.id === target.account_id));
  const missing = () => destinations().filter((origin) => !props.connections.some((api) => api.origin === origin));
  const submissionErrors = () => props.draft.results().filter((result) => result.error).length;
  let mounted = true;
  cleanup(() => {
    mounted = false;
  });
  async function send() {
    if (missing().length || checkingTargets() || staleTargets() || targetReadProblem()) return;
    const apis = destinations().flatMap((origin) => {
      const api = props.connections.find((item) => item.origin === origin);
      return api ? [api] : [];
    });
    const id = await submit(apis, local(), props.servers.label);
    if (!mounted) return;
    if (id) props.onAccepted(id);
    else if (problem()) announce(problem());
    else if (submissionErrors())
      announce(t("compose.submission_failed_servers", { count: submissionErrors() }));
  }

  return (
    <WorkspacePage
      title={t("compose.send_notification")}
      back={props.onBack}
      footer={
        <View class="gap-2">
          <Problem message={problem() || targetReadProblem() ||
            (staleTargets() ? t("compose.configured_targets_changed") : "")} />
          <If when={!busy() && !problem() && submissionErrors()}>
            <Hint>{t("compose.submission_failed_servers", { count: submissionErrors() })}</Hint>
          </If>
          <View class="flex-row flex-wrap items-center justify-between gap-3">
            <Hint>
              {checkingTargets() ? t("controls.loading") :
                !local() ? t("servers.count", { count: destinations().length }) : topic()
                ? t("common.topic_name_value", { name: topic() })
                : targets().length
                  ? t("compose.target_count", { count: targets().length })
                  : t("compose.use_default_routing")}
            </Hint>
            <Action
              label={
                busy()
                  ? t("compose.submitting")
                  : t("compose.send_notification")
              }
              onPress={() => void send()}
              kind="primary"
              disabled={!canSubmit() || !destinations().length || Boolean(missing().length) ||
                checkingTargets() || staleTargets() || Boolean(targetReadProblem())}
            />
          </View>
        </View>
      }
    >
      <If when={receipt() && !title() && !body()}>
        <Action
          label={t("compose.view_last_delivery")}
          kind="quiet"
          class="self-start"
          onPress={() => {
            const id = receipt();
            if (id) props.onAccepted(id);
          }}
        />
      </If>
      <If when={props.draft.results().length}>
        <Section title={t("servers.send_results")}>
          <If when={props.draft.results().some((outcome) => outcome.error)}>
            <Hint>{t("servers.retry_hint")}</Hint>
          </If>
          <Each of={props.draft.results()} key={(result) => result.origin}>
            {(result) => (
              <View class="gap-2 rounded-(--radius) border border-border bg-card px-3 py-2">
                <View class="min-w-0 flex-row flex-wrap items-center justify-between gap-2">
                  <Text class="font-semibold text-foreground">{props.servers.label(result().origin)}</Text>
                  <If when={result().receipt}>{(accepted) => (
                    <If when={accepted().status === "pending"} else={<DeliveryStatus value={accepted().status} />}>
                      <Text class="text-sm font-semibold text-warning">{t("servers.queued")}</Text>
                    </If>
                  )}</If>
                </View>
                <Problem message={result().error ?? ""} />
                <If when={props.onServerDelivery && result().receipt}>
                  {(accepted) => (
                    <Action label={t("history.delivery_details")} kind="quiet" class="self-start"
                      disabled={busy()}
                      onPress={() => props.onServerDelivery?.(result().origin, accepted().message_id)} />
                  )}
                </If>
              </View>
            )}
          </Each>
        </Section>
      </If>
      <Section title={t("compose.recipients")}>
        <If when={!props.fixedTopic && !topic()}>
          <View class="flex-row flex-wrap items-center justify-between gap-2">
            <Text class="text-sm font-semibold text-foreground">{t("servers.destinations")}</Text>
            <Action label={t("servers.manage")} kind="quiet" onPress={props.onManageServers} disabled={busy()} />
          </View>
          <ServerTags
            items={props.servers.items()}
            selected={selected()}
            disabled={busy()}
            onToggle={(origin) => props.draft.servers.set(toggleOrigin(selected(), origin))}
          />
          <If when={!local()}><Hint>{t("servers.route_hint")}</Hint></If>
          <Each of={missing()}>
            {(origin) => (
              <Action kind="secondary" class="self-start"
                label={t("servers.sign_in_name", { name: props.servers.label(origin()) })}
                disabled={busy()}
                onPress={() => props.onConnectServer(origin())} />
            )}
          </Each>
        </If>
        <If
          when={props.fixedTopic}
          else={
            <Choice
              label={t("common.topic")}
              value={topic()}
              disabled={busy()}
              items={[
                { value: "", title: t("common.direct_delivery") },
                ...(topics?.items() ?? []).map((item) => ({
                  value: item.name,
                  title: item.name,
                  disabled: !item.enabled,
                })),
              ]}
              onChange={(value) => {
                topic.set(value ?? "");
                topicPassword.set("");
                needsTopicPassword.set(false);
              }}
            />
          }
        >
          {(fixed) => (
            <Text class="text-base font-medium text-foreground">
              {t("common.topic_name_value", { name: fixed().name })}
            </Text>
          )}
        </If>
        <If
          when={needsTopicPassword() || (props.fixedTopic?.protected ??
            topics?.items().find((item) => item.name === topic())?.protected)}
        >
          <Field
            label={t("compose.topic_password_if_needed")}
            masked
            disabled={busy()}
            value={topicPassword()}
            onChange={topicPassword.set}
          />
        </If>
        <If when={topics?.next()}>
          <Action
            label={t("compose.load_more_topics")}
            kind="quiet"
            class="self-start"
            disabled={busy() || topics?.loading()}
            onPress={() => void topics?.more()}
          />
        </If>
        <If when={topics?.problem()}>
          <Hint>{topics?.problem()}</Hint>
        </If>
        <If when={topic() || props.fixedTopic}>
          <Hint>{t("servers.topic_on", { name: props.servers.label(props.api.origin) })}</Hint>
        </If>
      </Section>
      <Panel>
        <Field
          label={t("common.title")}
          value={title()}
          onChange={title.set}
          placeholder={t("compose.notification_title")}
          disabled={busy()}
        />
        <Field
          label={t("common.body")}
          value={body()}
          onChange={body.set}
          placeholder={t("compose.write_a_notification")}
          autoCapitalize="sentences"
          multiline
          disabled={busy()}
        />
        <Choice
          label={t("common.body_format")}
          items={formats()}
          value={format()}
          disabled={busy()}
          onChange={(value) => format.set((value ?? "text") as Format)}
        />
        <If when={props.canManageTargets || speech()}>
          <Toggle label={t("speech.send_as_voice")} checked={speech()} onChange={speech.set} disabled={busy()} />
          <If when={speech()}><Hint>{t("speech.uses_server_settings")}</Hint></If>
        </If>
      </Panel>
      <If when={local() && (props.canManageTargets || targets().length > 0)}>
        <Section title={t("compose.choose_channel_accounts")}>
          <Hint>{topic() ? t("compose.use_this_topic_s_routing_and") : t("compose.use_the_server_s_default_routing")}</Hint>
          <SelectionTags
            items={configuredAccounts()}
            selected={targets().flatMap((target) => target.account_id ? [target.account_id] : [])}
            onToggle={(account_id) => targets.update((items) => items.some((target) => target.account_id === account_id)
              ? items.filter((target) => target.account_id !== account_id)
              : [...items, { account_id }])}
            disabled={busy()}
          />
          <If when={targets().length}>
            <Action label={t("compose.use_routing")} kind="quiet" class="self-start"
              disabled={busy()} onPress={() => targets.set([])} />
          </If>
          <If when={props.canManageTargets && !configuredAccounts().length && !accounts.loading() &&
            !accounts.next() && !accounts.problem() && !checkingTargets()}>
            <View class="flex-row flex-wrap items-center justify-between gap-2">
              <Hint>{t("compose.no_configured_channels")}</Hint>
              <Action label={t("compose.manage_channels")} onPress={props.onManageChannels} disabled={busy()} />
            </View>
          </If>
          <Problem message={accounts.problem()} />
          <If when={accounts.problem() || targetReadProblem()}>
            <Action label={t("common.refresh")} kind="quiet" class="self-start"
              disabled={busy() || accounts.loading()}
              onPress={() => {
                if (targetReadProblem()) void resolvedAccounts.refetch();
                if (accounts.problem()) void accounts.reload();
              }} />
          </If>
          <If when={accounts.next()}>
            <Action label={t("common.load_more_accounts")} class="self-start" kind="quiet"
              disabled={busy() || accounts.loading()} onPress={() => void accounts.more()} />
          </If>
        </Section>
      </If>
      <Action
        label={
          advanced()
            ? t("compose.hide_send_options")
            : t("compose.show_send_options")
        }
        kind="quiet"
        class="self-start"
        disabled={busy()}
        onPress={() => advanced.update((value) => !value)}
      />
      <If when={advanced()}>
        <Panel>
          <Field
            label={t("compose.message_tags")}
            value={tags()}
            disabled={busy()}
            onChange={tags.set}
            hint={t("common.separate_multiple_tags_with_commas")}
          />
          <Choice
            label={t("compose.severity")}
            value={level()}
            disabled={busy()}
            items={[
              { value: "info", title: t("compose.info") },
              { value: "warn", title: t("compose.warning") },
              { value: "error", title: t("compose.error") },
            ]}
            onChange={(value) => level.set(value ?? "info")}
          />
          <Field
            label={t("compose.notification_link")}
            keyboard="url"
            value={link()}
            disabled={busy()}
            onChange={link.set}
          />
          <Field
            label={t("compose.attachment_url")}
            keyboard="url"
            value={attachment()}
            disabled={busy()}
            onChange={attachment.set}
            hint={t("compose.use_a_link_that_the_receiving")}
          />
          <If when={attachment().trim()}>
            <View class="gap-3">
              <Field
                label={t("compose.attachment_name")}
                value={attachmentName()}
                disabled={busy()}
                onChange={attachmentName.set}
              />
              <Field
                label={t("compose.attachment_type")}
                value={attachmentType()}
                disabled={busy()}
                onChange={attachmentType.set}
                placeholder="image/png"
              />
            </View>
          </If>
          <Field
            label={t("compose.expiration_seconds")}
            keyboard="numeric"
            value={expiresIn()}
            disabled={busy()}
            onChange={expiresIn.set}
          />
          <Field
            label={t("compose.final_status_callback_url")}
            keyboard="url"
            value={callback()}
            disabled={busy()}
            onChange={callback.set}
          />
          <Field
            label={t("compose.extra_fields_json")}
            multiline
            value={extras()}
            disabled={busy()}
            onChange={extras.set}
          />
          <Toggle
            label={t("compose.wait_for_delivery_result")}
            checked={wait()}
            disabled={busy()}
            onChange={wait.set}
          />
          <If when={local()}><StrategyEditor draft={strategy} optional disabled={busy()} /></If>
        </Panel>
      </If>
    </WorkspacePage>
  );
}
