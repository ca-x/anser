import { t } from "nsh/i18n";
import { announce, cleanup, signal, Text, View } from "nsh";
import { Button } from "nsh/base";
import { messageFor, type AnserApi } from "../api";
import type { Format, InboxInteraction, InboxItem, InteractionReply } from "../contracts";
import { canPlaySpeech, speechBody, type SpeechPlayback } from "../components/Speech";
import type { InboxState, SystemNotifications } from "../inbox";
import {
  Action,
  Choice,
  Field,
  Hint,
  Panel,
  Problem,
  ReadState,
  Toggle,
} from "../components/Controls";
import { localTime } from "../components/DeliveryStatus";
import {
  messagePreview,
  WorkspacePage,
} from "../components/Workspace";
import { operation } from "../state";

function sender(item: InboxItem) {
  return item.from_username
    ? t("inbox.from_user", { username: item.from_username })
    : item.topic
      ? t("common.topic_name_value", { name: item.topic })
      : t("inbox.server_notification");
}

export function Inbox(props: {
  state: InboxState;
  notifications: SystemNotifications;
  onNotificationSettings: () => void;
  onOpen: (id: number) => void;
  onSend: () => void;
}) {
  const state = props.state;
  const notifications = props.notifications;
  const notificationLabel = () => {
    const serviceUnavailable = notifications.enabled() &&
      !notifications.native() && !notifications.checkingPermission();
    if (notifications.nativeMessage() || serviceUnavailable)
      return t("inbox.notification_settings_attention");
    return t(notifications.enabled() ? "inbox.notification_settings" : "inbox.notification_settings_off");
  };
  return (
    <WorkspacePage title={t("common.inbox")}>
      <View class="flex-row flex-wrap items-center justify-between gap-2">
        <View class="min-w-0 flex-row flex-wrap items-center gap-1">
          <Action
            label={t("common.refresh")}
            kind="quiet"
            onPress={state.reload}
            disabled={state.loading()}
          />
          <Action
            label={notificationLabel()}
            kind="quiet"
            onPress={props.onNotificationSettings}
          />
        </View>
        <Action
          label={t("inbox.message_a_user")}
          kind="primary"
          onPress={props.onSend}
        />
      </View>
      <ReadState
        loading={state.loading()}
        problem={state.problem()}
        empty={!state.items().length}
        emptyLabel={t("inbox.no_incoming_notifications")}
      />
      <If when={state.items().length > 0}>
        <View class="rounded-(--radius) border border-border bg-card">
          <Each of={state.items()} key={(item) => item.id}>
            {(item, index) => {
              const title = () => canPlaySpeech(item().audio_path)
                ? item().title.trim() || t("speech.notification")
                : messagePreview(item()) ?? t("history.notification");
              const unread = () => item().read_at == null;
              const subtitle = () => `${sender(item())} · ${localTime(item().created_at)}`;
              const divider = () => index() < state.items().length - 1 ? "border-b border-border" : "";
              const accessibleLabel = () => [
                t("inbox.open_message", { title: title() }),
                unread() ? t("inbox.unread") : "",
                subtitle(),
              ].filter(Boolean).join(" · ");
              return (
                <Button
                  testID={`inbox-item-${item().id}`}
                  accessibilityLabel={accessibleLabel()}
                  onPress={() => props.onOpen(item().id)}
                  class={`min-h-16 min-w-0 flex-row items-center gap-3 rounded-(--radius) px-3 py-2.5 hover:bg-muted active:bg-accent focus-visible:ring-2 focus-visible:ring-ring ${divider()}`}
                >
                  <View class="min-w-0 flex-1 gap-0.5">
                    <Text class={`line-clamp-2 text-base text-card-foreground ${unread() ? "font-semibold" : "font-medium"}`}>{title()}</Text>
                    <Text class="line-clamp-1 text-sm text-muted-foreground">{subtitle()}</Text>
                  </View>
                  <If when={unread()}>
                    <Text class="text-xs font-semibold text-warning">{t("inbox.unread")}</Text>
                  </If>
                  <Text accessibilityElementsHidden class="text-lg text-muted-foreground">›</Text>
                </Button>
              );
            }}
          </Each>
        </View>
      </If>
    </WorkspacePage>
  );
}

export function InboxDetail(props: {
  api: AnserApi;
  state: InboxState;
  speech: SpeechPlayback;
  id: number;
  onBack: () => void;
  onReply: (recipient: string) => void;
}) {
  const item = () => props.state.items().find((entry) => entry.id === props.id);
  const action = operation();
  if (item()?.read_at == null && item())
    void action.run(() => props.state.markRead(props.id));

  return (
    <WorkspacePage title={t("inbox.received_notification")} back={props.onBack}>
      <Problem message={action.problem()} />
      <If
        when={item()}
        else={<Hint>{t("inbox.this_notification_could_not_be_found")}</Hint>}
      >
        {(message) => (
          <Panel>
            <Text
              role="header"
              class="text-[19px] font-semibold text-foreground"
            >
              {message().title.trim() || t(canPlaySpeech(message().audio_path) ? "speech.notification" : "history.notification")}
            </Text>
            <Hint>
              {sender(message())} / {localTime(message().created_at)}
            </Hint>
            <If when={speechBody(message().body, message().audio_path)}>
              {(body) => (
                <View selectable>
                  <Text class="text-base leading-6 text-foreground">
                    {body()}
                  </Text>
                </View>
              )}
            </If>
            <If when={canPlaySpeech(message().audio_path)}>
              <Action label={t("speech.play")} onPress={() => props.speech.replay(props.api.origin, message())} class="self-start" />
            </If>
            <If when={message().interaction_id}>
              <InteractionControls api={props.api} id={props.id} />
            </If>
            <If when={message().from_username}>
              {(username) => (
                <Action
                  label={t("inbox.reply_to", { username: username() })}
                  onPress={() => props.onReply(username())}
                  class="self-start"
                />
              )}
            </If>
            <If when={message().read_at == null && action.problem()}>
              <Action
                label={t("inbox.mark_as_read")}
                onPress={() =>
                  void action.run(() => props.state.markRead(props.id))
                }
              />
            </If>
          </Panel>
        )}
      </If>
    </WorkspacePage>
  );
}

function InteractionControls(props: { api: AnserApi; id: number }) {
  const action = operation();
  const form = signal<InboxInteraction | undefined>(undefined);
  const note = signal("");
  const choice = signal<string | null>(null);
  const abort = new AbortController();
  cleanup(() => abort.abort());

  const load = () => void action.run(async () => {
    form.set(await props.api.inboxInteraction(props.id, abort.signal));
  });
  const submit = (reply: InteractionReply) => void action.run(async () => {
    const result = await props.api.replyToInteraction(props.id, reply);
    const current = form();
    if (current && action.live()) {
      form.set({ ...current, ...result });
      announce(t("inbox.interaction_answered"));
    }
  });
  load();

  return <View class="gap-3 border-t border-border pt-4">
    <Problem message={action.problem()} />
    <If when={form()} else={
      <If when={action.busy()} else={<Action label={t("inbox.interaction_retry")} onPress={load} />}>
        <Hint>{t("inbox.interaction_loading")}</Hint>
      </If>
    }>
      {(value) => <If when={value().status === "pending"} else={
        <Hint>{t(value().status === "answered" ? "inbox.interaction_answered" : "inbox.interaction_expired")}</Hint>
      }>
        <Hint>{t("inbox.interaction_expires", { time: localTime(value().expires_at) })}</Hint>
        <Each of={value().form.buttons} key={(button) => button.value}>
          {(button) => <Action label={button().label} disabled={action.busy()}
            onPress={() => submit({ kind: "action", value: button().value })} />}
        </Each>
        <If when={value().form.select}>
          {(field) => <View class="gap-2">
            <Choice label={field().label} value={choice()} disabled={action.busy()}
              items={field().options.map((option) => ({ value: option.value, title: option.label }))} onChange={choice.set} />
            <Action kind="primary" label={field().submit} disabled={action.busy() || choice() == null}
              onPress={() => { const selected = choice(); if (selected != null) submit({ kind: "choice", value: selected }); }} />
          </View>}
        </If>
        <If when={value().form.input}>
          {(field) => <View class="gap-2">
            <Field label={field().label} value={note()} onChange={note.set} disabled={action.busy()}
              multiline={field().multiline} placeholder={field().placeholder ?? undefined} />
            <If when={Array.from(note()).length > field().max_length}>
              <Hint>{t("inbox.interaction_text_limit", { count: field().max_length })}</Hint>
            </If>
            <Action kind="primary" label={field().submit}
              disabled={action.busy() || !note().trim() || Array.from(note()).length > field().max_length}
              onPress={() => submit({ kind: "text", text: note() })} />
          </View>}
        </If>
      </If>}
    </If>
  </View>;
}

export function inboxDraft(fixedRecipient = "") {
  const recipient = signal(fixedRecipient);
  const title = signal("");
  const body = signal("");
  const format = signal<Format>("text");
  const speech = signal(false);
  const busy = signal(false);
  const problem = signal("");
  const sent = signal<{ recipient: string; messageId?: string } | undefined>(
    undefined,
  );
  let pending: { content: string; key: string } | undefined;

  const canSubmit = () =>
    !busy() &&
    Boolean(recipient().trim()) &&
    Boolean(title().trim() || body().trim());

  async function submit(api: AnserApi) {
    const target = fixedRecipient || recipient().trim();
    if (!canSubmit()) return;
    busy.set(true);
    problem.set("");
    sent.set(undefined);
    try {
      const message = { title: title().trim(), body: body(), format: format() };
      const content = JSON.stringify([target, message, speech()]);
      if (!pending || pending.content !== content)
        pending = { content, key: crypto.randomUUID() };
      const receipt = await api.sendInbox(target, message, pending.key, speech());
      pending = undefined;
      title.set("");
      body.set("");
      sent.set({ recipient: target, messageId: receipt.message_id });
    } catch (error) {
      problem.set(messageFor(error));
    } finally {
      busy.set(false);
    }
  }
  return {
    recipient,
    fixedRecipient,
    title,
    body,
    format,
    speech,
    busy,
    problem,
    sent,
    canSubmit,
    submit,
  };
}

export function InboxSend(props: {
  api: AnserApi;
  draft: ReturnType<typeof inboxDraft>;
  canSendSpeech: boolean;
  onBack: () => void;
  onDelivery: (id: string) => void;
}) {
  const {
    recipient,
    fixedRecipient,
    title,
    body,
    format,
    speech,
    busy,
    problem,
    sent,
    canSubmit,
    submit,
  } = props.draft;
  let mounted = true;
  cleanup(() => {
    mounted = false;
  });
  async function send() {
    await submit(props.api);
    if (mounted && problem()) announce(problem());
  }

  return (
    <WorkspacePage
      title={t("inbox.message_a_user")}
      back={props.onBack}
      footer={
        <View class="gap-2">
          <Problem message={problem()} />
          <If when={title() || body() ? undefined : sent()}>
            {(result) => (
              <View class="flex-row flex-wrap items-center justify-between gap-2">
                <Text class="text-sm text-success">
                  {t("inbox.sent_to", { recipient: result().recipient })}
                </Text>
                <If when={result().messageId}>
                  {(id) => (
                    <Action
                      label={t("history.delivery_details")}
                      kind="quiet"
                      onPress={() => props.onDelivery(id())}
                    />
                  )}
                </If>
              </View>
            )}
          </If>
          <Action
            label={busy() ? t("inbox.sending") : t("inbox.send_message")}
            onPress={() => void send()}
            kind="primary"
            disabled={!canSubmit()}
          />
        </View>
      }
    >
      <Panel>
        <If
          when={fixedRecipient}
          else={
            <Field
              label={t("inbox.recipient_username")}
              value={recipient()}
              onChange={recipient.set}
              disabled={busy()}
            />
          }
        >
          {(username) => (
            <Text class="text-base font-medium text-foreground">
              {t("history.to_user", { username: username() })}
            </Text>
          )}
        </If>
        <Field
          label={t("common.title")}
          value={title()}
          onChange={title.set}
          disabled={busy()}
        />
        <Field
          label={t("common.body")}
          value={body()}
          onChange={body.set}
          multiline
          disabled={busy()}
        />
        <Choice
          label={t("common.body_format")}
          value={format()}
          disabled={busy()}
          items={[
            { value: "text", title: t("common.plain_text") },
            { value: "markdown", title: "Markdown" },
            { value: "html", title: "HTML" },
          ]}
          onChange={(value) => format.set((value ?? "text") as Format)}
        />
        <If when={props.canSendSpeech}>
          <Toggle label={t("speech.send_as_voice")} checked={speech()} onChange={speech.set} />
          <If when={speech()}><Hint>{t("speech.uses_server_settings")}</Hint></If>
        </If>
      </Panel>
    </WorkspacePage>
  );
}
