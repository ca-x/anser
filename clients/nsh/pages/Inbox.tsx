import { t } from "nsh/i18n";
import { announce, cleanup, signal, Text, View } from "nsh";
import { messageFor, type AnserApi } from "../api";
import type { Format, InboxInteraction, InboxItem, InteractionReply } from "../contracts";
import type { SpeechPlayback } from "../components/Speech";
import type { InboxState } from "../inbox";
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
  RecordRow,
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
  speech: SpeechPlayback;
  onOpen: (id: number) => void;
  onSend: () => void;
}) {
  const state = props.state;
  return (
    <WorkspacePage title={t("common.inbox")}>
      <View class="flex-row flex-wrap items-center justify-between gap-2">
        <Action
          label={t("common.refresh")}
          kind="quiet"
          onPress={state.reload}
          disabled={state.loading()}
        />
        <Action
          label={t("inbox.message_a_user")}
          kind="primary"
          onPress={props.onSend}
        />
      </View>
      <Panel>
        <Toggle
          label={t("inbox.show_system_notifications_for_this_session")}
          checked={state.native()}
          onChange={state.changeNative}
        />
        <Toggle label={t("speech.autoplay")} checked={props.speech.auto()} onChange={props.speech.changeAuto} />
        <Hint>{t("inbox.messages_arrive_while_the_app_is")}</Hint>
        <Problem message={state.nativeMessage()} />
      </Panel>
      <ReadState
        loading={state.loading()}
        problem={state.problem()}
        empty={!state.items().length}
        emptyLabel={t("inbox.no_incoming_notifications")}
      />
      <Each of={state.items()} key={(item) => item.id}>
        {(item) => (
          <RecordRow
            title={messagePreview(item()) ?? t("history.notification")}
            subtitle={`${sender(item())} / ${localTime(item().created_at)}`}
            status={
              <If when={item().read_at == null}>
                <Text class="text-sm font-semibold text-waiting">
                  {t("inbox.unread")}
                </Text>
              </If>
            }
            onPress={() => props.onOpen(item().id)}
          />
        )}
      </Each>
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
              {message().title.trim() || t("history.notification")}
            </Text>
            <Hint>
              {sender(message())} / {localTime(message().created_at)}
            </Hint>
            <If when={message().body}>
              {(body) => (
                <View selectable>
                  <Text class="text-base leading-6 text-foreground">
                    {body()}
                  </Text>
                </View>
              )}
            </If>
            <If when={message().audio_path}>
              <Action label={t("speech.play")} onPress={() => props.speech.replay(message())} class="self-start" />
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
      const content = JSON.stringify([target, message]);
      if (!pending || pending.content !== content)
        pending = { content, key: crypto.randomUUID() };
      const receipt = await api.sendInbox(target, message, pending.key);
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
  onBack: () => void;
  onDelivery: (id: string) => void;
}) {
  const {
    recipient,
    fixedRecipient,
    title,
    body,
    format,
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
      </Panel>
    </WorkspacePage>
  );
}
