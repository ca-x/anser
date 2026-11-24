import { t } from "nsh/i18n";
import { announce, cleanup, signal, Text, View } from "nsh";
import { messageFor, type AnserApi } from "../api";
import type { Channel, Format, Publish, Target, Topic } from "../contracts";
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
import { strategyDraft, StrategyEditor, Targets } from "../components/Routing";
import { WorkspacePage } from "../components/Workspace";
import { ServerTags } from "../components/ServerProfiles";
import { toggleOrigin, type Servers } from "../servers";
import { paged } from "../state";

const formats = () => [
  { value: "text", title: t("common.plain_text") },
  { value: "markdown", title: "Markdown" },
  { value: "html", title: "HTML" },
];

export function composeDraft(initialTopic = "") {
  const topic = signal(initialTopic);
  const title = signal("");
  const body = signal("");
  const format = signal<Format>("text");
  const targets = signal<Target[]>([]);
  const tags = signal("");
  const link = signal("");
  const level = signal("info");
  const topicPassword = signal("");
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
  const results = signal<{ origin: string; id?: string; error?: string }[]>([]);
  let pending: { request: string; key: string; expiry?: number; accepted: Map<string, string> } | undefined;

  const canSubmit = () => !busy() && Boolean(title().trim() || body().trim());

  async function submit(apis: AnserApi[], local: boolean) {
    if (!canSubmit() || !apis.length) return;
    busy.set(true);
    problem.set("");
    try {
      const next: Publish = {
        title: title().trim(),
        body: body(),
        format: format(),
      };
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
      const request = JSON.stringify([destination, next, expirySeconds]);
      if (!pending || pending.request !== request) {
        pending = {
          request,
          key: crypto.randomUUID(),
          accepted: new Map(),
          expiry:
            expirySeconds === undefined
              ? undefined
              : Date.now() + expirySeconds * 1000,
        };
      }
      const batch = pending;
      next.expire_at = batch.expiry;
      const outcomes = await Promise.all(apis.map(async (api) => {
        const previous = batch.accepted.get(api.origin);
        if (previous) return { origin: api.origin, id: previous };
        try {
          const accepted = await api.publish(destination, next, batch.key, wait());
          batch.accepted.set(api.origin, accepted.message_id);
          return { origin: api.origin, id: accepted.message_id };
        } catch (error) {
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
      servers.set(undefined);
      const id = local ? outcomes[0]?.id : undefined;
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
    targets,
    tags,
    link,
    level,
    topicPassword,
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
  fixedTopic?: Topic;
  draft: ReturnType<typeof composeDraft>;
  servers: Servers;
  connections: AnserApi[];
  onConnectServer: (origin: string) => void;
  onManageServers: () => void;
  onBack?: () => void;
  onAccepted: (id: string) => void;
}) {
  const accounts = paged(props.api.accounts.bind(props.api));
  const topics = props.fixedTopic
    ? undefined
    : paged(props.api.topics.bind(props.api));
  const {
    topic,
    title,
    body,
    format,
    targets,
    tags,
    link,
    level,
    topicPassword,
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
  const missing = () => destinations().filter((origin) => !props.connections.some((api) => api.origin === origin));
  let mounted = true;
  cleanup(() => {
    mounted = false;
  });
  async function send() {
    if (missing().length) return;
    const apis = destinations().flatMap((origin) => {
      const api = props.connections.find((item) => item.origin === origin);
      return api ? [api] : [];
    });
    const id = await submit(apis, local());
    if (!mounted) return;
    if (id) props.onAccepted(id);
    else if (problem()) announce(problem());
  }

  return (
    <WorkspacePage
      title={t("compose.send_notification")}
      back={props.onBack}
      footer={
        <View class="gap-2">
          <Problem message={problem()} />
          <View class="flex-row flex-wrap items-center justify-between gap-3">
            <Hint>
              {!local() ? t("servers.count", { count: destinations().length }) : topic()
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
              disabled={!canSubmit() || !destinations().length || Boolean(missing().length)}
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
              <View class="gap-1 rounded-(--radius) border border-border bg-card px-3 py-2">
                <Text class="font-semibold text-foreground">{props.servers.label(result().origin)}</Text>
                <If when={result().id} else={<Problem message={result().error ?? ""} />}>
                  <Text class="text-sm text-success">{t("servers.queued")}</Text>
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
          when={
            props.fixedTopic?.protected ??
            topics?.items().find((item) => item.name === topic())?.protected
          }
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
            disabled={topics?.loading()}
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
          onChange={(value) => format.set((value ?? "text") as Format)}
        />
      </Panel>
      <If when={local()}>
      <Targets
        title={t("compose.choose_channels_or_accounts")}
        targets={targets()}
        onChange={targets.set}
        channels={props.channels}
        accounts={accounts.items()}
        emptyLabel={
          topic()
            ? t("compose.use_this_topic_s_routing_and")
            : t("compose.use_the_server_s_default_routing")
        }
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
      </If>
      <Action
        label={
          advanced()
            ? t("compose.hide_send_options")
            : t("compose.show_send_options")
        }
        kind="quiet"
        class="self-start"
        onPress={() => advanced.update((value) => !value)}
      />
      <If when={advanced()}>
        <Panel>
          <Field
            label={t("compose.message_tags")}
            value={tags()}
            onChange={tags.set}
            hint={t("common.separate_multiple_tags_with_commas")}
          />
          <Choice
            label={t("compose.severity")}
            value={level()}
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
            onChange={link.set}
          />
          <Field
            label={t("compose.attachment_url")}
            keyboard="url"
            value={attachment()}
            onChange={attachment.set}
            hint={t("compose.use_a_link_that_the_receiving")}
          />
          <If when={attachment().trim()}>
            <View class="gap-3">
              <Field
                label={t("compose.attachment_name")}
                value={attachmentName()}
                onChange={attachmentName.set}
              />
              <Field
                label={t("compose.attachment_type")}
                value={attachmentType()}
                onChange={attachmentType.set}
                placeholder="image/png"
              />
            </View>
          </If>
          <Field
            label={t("compose.expiration_seconds")}
            keyboard="numeric"
            value={expiresIn()}
            onChange={expiresIn.set}
          />
          <Field
            label={t("compose.final_status_callback_url")}
            keyboard="url"
            value={callback()}
            onChange={callback.set}
          />
          <Field
            label={t("compose.extra_fields_json")}
            multiline
            value={extras()}
            onChange={extras.set}
          />
          <Toggle
            label={t("compose.wait_for_delivery_result")}
            checked={wait()}
            onChange={wait.set}
          />
          <If when={local()}><StrategyEditor draft={strategy} optional /></If>
        </Panel>
      </If>
    </WorkspacePage>
  );
}
