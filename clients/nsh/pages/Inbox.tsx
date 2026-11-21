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
    ? `来自 ${item.from_username}`
    : item.topic
      ? `Topic：${item.topic}`
      : "服务器通知";
}

export function Inbox(props: {
  state: InboxState;
  onOpen: (id: number) => void;
  onSend: () => void;
}) {
  const state = props.state;
  return (
    <WorkspacePage title="收件箱">
      <View class="flex-row flex-wrap items-center justify-between gap-2">
        <Action
          label="刷新"
          kind="quiet"
          onPress={state.reload}
          disabled={state.loading()}
        />
        <Action label="给用户发消息" kind="primary" onPress={props.onSend} />
      </View>
      <Panel>
        <Toggle
          label="本次连接显示系统通知"
          checked={state.native()}
          onChange={state.changeNative}
        />
        <Hint>
          应用运行时接收消息。系统通知只提醒有新消息，详情在收件箱查看。
        </Hint>
        <Problem message={state.nativeMessage()} />
      </Panel>
      <ReadState
        loading={state.loading()}
        problem={state.problem()}
        empty={!state.items().length}
        emptyLabel="暂无收到的通知。"
      />
      <Each of={state.items()} key={(item) => item.id}>
        {(item) => (
          <RecordRow
            title={item().title}
            subtitle={`${sender(item())} / ${localTime(item().created_at)}`}
            status={
              <If when={item().read_at == null}>
                <Text class="text-sm font-semibold text-waiting">未读</Text>
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
    <WorkspacePage title="收到的通知" back={props.onBack}>
      <Problem message={action.problem()} />
      <If when={item()} else={<Hint>找不到这条通知。</Hint>}>
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
                label="标为已读"
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
      sent.set(`消息已发送给 ${target}。`);
    });
  }

  return (
    <WorkspacePage
      title="给用户发消息"
      back={props.onBack}
      footer={
        <Action
          label={action.busy() ? "正在发送…" : "发送消息"}
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
          label="收件人用户名"
          value={recipient()}
          onChange={recipient.set}
          disabled={action.busy()}
        />
        <Field
          label="标题"
          value={title()}
          onChange={title.set}
          disabled={action.busy()}
        />
        <Field
          label="正文"
          value={body()}
          onChange={body.set}
          multiline
          disabled={action.busy()}
        />
        <Choice
          label="正文格式"
          value={format()}
          disabled={action.busy()}
          items={[
            { value: "text", title: "纯文本" },
            { value: "markdown", title: "Markdown" },
            { value: "html", title: "HTML" },
          ]}
          onChange={(value) => format.set((value ?? "text") as Format)}
        />
      </Panel>
    </WorkspacePage>
  );
}
