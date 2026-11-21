import { t } from "nsh/i18n";
import { signal, Text, View } from "nsh";
import type { AnserApi } from "../api";
import type { Format, InboxItem } from "../contracts";
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
import { RecordRow, WorkspacePage } from "../components/Workspace";
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
            title={item().title}
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
  state: InboxState;
  id: number;
  onBack: () => void;
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
              {message().title}
            </Text>
            <Hint>
              {sender(message())} / {localTime(message().created_at)}
            </Hint>
            <View selectable>
              <Text class="text-base leading-6 text-foreground">
                {message().body}
              </Text>
            </View>
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

export function InboxSend(props: { api: AnserApi; onBack: () => void }) {
  const recipient = signal("");
  const title = signal("");
  const body = signal("");
  const format = signal<Format>("text");
  const action = operation();
  const sent = signal("");

  function send() {
    void action.run(async () => {
      sent.set("");
      const target = recipient().trim();
      await props.api.sendInbox(target, {
        title: title().trim(),
        body: body(),
        format: format(),
      });
      if (!action.live()) return;
      title.set("");
      body.set("");
      sent.set(t("inbox.sent_to", { recipient: target }));
    });
  }

  return (
    <WorkspacePage
      title={t("inbox.message_a_user")}
      back={props.onBack}
      footer={
        <Action
          label={action.busy() ? t("inbox.sending") : t("inbox.send_message")}
          onPress={send}
          kind="primary"
          disabled={
            action.busy() ||
            !recipient().trim() ||
            !title().trim() ||
            !body().trim()
          }
        />
      }
    >
      <Problem message={action.problem()} />
      <If when={sent()}>
        <Text class="text-sm text-success">{sent()}</Text>
      </If>
      <Panel>
        <Field
          label={t("inbox.recipient_username")}
          value={recipient()}
          onChange={recipient.set}
          disabled={action.busy()}
        />
        <Field
          label={t("common.title")}
          value={title()}
          onChange={title.set}
          disabled={action.busy()}
        />
        <Field
          label={t("common.body")}
          value={body()}
          onChange={body.set}
          multiline
          disabled={action.busy()}
        />
        <Choice
          label={t("common.body_format")}
          value={format()}
          disabled={action.busy()}
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
