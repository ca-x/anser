import { signal, View } from "nsh";
import type { AnserApi } from "../api";
import type { Channel, Format, Publish, Target } from "../contracts";
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
import { operation, paged } from "../state";

const formats = [
  { value: "text", title: "纯文本" },
  { value: "markdown", title: "Markdown" },
  { value: "html", title: "HTML" },
];

export function Compose(props: {
  api: AnserApi;
  channels: Channel[];
  initialTopic?: string;
  onAccepted: (id: string) => void;
}) {
  const accounts = paged(props.api.accounts.bind(props.api));
  const topics = paged(props.api.topics.bind(props.api));
  const topic = signal(props.initialTopic ?? "");
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
  const delivery = operation();
  let pending: { request: string; key: string; expiry?: number } | undefined;

  function send() {
    void delivery.run(async () => {
      if (!title().trim() || !body().trim()) return;
      const next: Publish = {
        title: title().trim(),
        body: body(),
        format: format(),
      };
      if (targets().length) next.channels = targets();
      const messageTags = tagsFrom(tags());
      if (messageTags.length) next.tags = messageTags;
      next.url = optionalHttpUrl(link(), "通知链接");
      next.level = level();
      if (topic() && topicPassword()) next.topic_password = topicPassword();
      const file = optionalHttpUrl(attachment(), "附件地址");
      if (file)
        next.attachments = [
          {
            url: file,
            name: attachmentName().trim() || undefined,
            content_type: attachmentType().trim() || undefined,
          },
        ];
      if (extras().trim()) next.extras = parseObject(extras(), "扩展字段");
      if (callback().trim())
        next.callback_url = optionalHttpUrl(callback(), "回调地址");
      // Preserve both the idempotency key and the original absolute expiry when a timed-out request is retried.
      const expirySeconds = expiresIn().trim()
        ? integer(expiresIn(), "有效期", 1, 604800)
        : undefined;
      const requestedStrategy = strategy.value();
      if (Object.keys(requestedStrategy).length)
        next.strategy = requestedStrategy;
      const request = JSON.stringify([topic(), next, expirySeconds, wait()]);
      if (!pending || pending.request !== request) {
        pending = {
          request,
          key: crypto.randomUUID(),
          expiry:
            expirySeconds === undefined
              ? undefined
              : Date.now() + expirySeconds * 1000,
        };
      }
      next.expire_at = pending.expiry;
      const accepted = await props.api.publish(
        topic() || undefined,
        next,
        pending.key,
        wait(),
      );
      if (!delivery.live()) return;
      pending = undefined;
      title.set("");
      body.set("");
      props.onAccepted(accepted.message_id);
    });
  }

  return (
    <WorkspacePage
      title="发送通知"
      footer={
        <View class="flex-row flex-wrap items-center justify-between gap-3">
          <Hint>
            {topic()
              ? `Topic：${topic()}`
              : targets().length
                ? `已选 ${targets().length} 个目标`
                : "使用默认路由"}
          </Hint>
          <Action
            label={delivery.busy() ? "正在提交…" : "发送通知"}
            onPress={send}
            kind="primary"
            disabled={delivery.busy() || !title().trim() || !body().trim()}
          />
        </View>
      }
    >
      <Problem message={delivery.problem()} />
      <Section title="收件范围">
        <Choice
          label="Topic"
          value={topic()}
          items={[
            { value: "", title: "直接投递" },
            ...topics
              .items()
              .map((item) => ({
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
        <If
          when={
            topic() &&
            topics.items().find((item) => item.name === topic())?.protected
          }
        >
          <Field
            label="Topic 密码（如需）"
            masked
            value={topicPassword()}
            onChange={topicPassword.set}
          />
        </If>
        <If when={topics.next()}>
          <Action
            label="加载更多 Topic"
            kind="quiet"
            class="self-start"
            disabled={topics.loading()}
            onPress={topics.more}
          />
        </If>
        <If when={topics.problem()}>
          <Hint>{topics.problem()}</Hint>
        </If>
      </Section>
      <Panel>
        <Field
          label="标题"
          value={title()}
          onChange={title.set}
          placeholder="通知标题"
          disabled={delivery.busy()}
        />
        <Field
          label="正文"
          value={body()}
          onChange={body.set}
          placeholder="写下要发送的通知"
          autoCapitalize="sentences"
          multiline
          disabled={delivery.busy()}
        />
        <Choice
          label="正文格式"
          items={formats}
          value={format()}
          onChange={(value) => format.set((value ?? "text") as Format)}
        />
      </Panel>
      <Targets
        title="指定渠道或账号"
        targets={targets()}
        onChange={targets.set}
        channels={props.channels}
        accounts={accounts.items()}
        emptyLabel={
          topic() ? "使用该 Topic 的路由和订阅。" : "使用服务器默认路由。"
        }
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
      <Action
        label={advanced() ? "收起发送选项" : "显示发送选项"}
        kind="quiet"
        class="self-start"
        onPress={() => advanced.update((value) => !value)}
      />
      <If when={advanced()}>
        <Panel>
          <Field
            label="消息标签"
            value={tags()}
            onChange={tags.set}
            hint="多个标签用逗号分隔。"
          />
          <Choice
            label="级别"
            value={level()}
            items={[
              { value: "info", title: "信息" },
              { value: "warn", title: "警告" },
              { value: "error", title: "错误" },
            ]}
            onChange={(value) => level.set(value ?? "info")}
          />
          <Field
            label="通知链接"
            keyboard="url"
            value={link()}
            onChange={link.set}
          />
          <Field
            label="附件地址"
            keyboard="url"
            value={attachment()}
            onChange={attachment.set}
            hint="使用接收渠道可访问的链接。"
          />
          <If when={attachment().trim()}>
            <View class="gap-3">
              <Field
                label="附件名称"
                value={attachmentName()}
                onChange={attachmentName.set}
              />
              <Field
                label="附件类型"
                value={attachmentType()}
                onChange={attachmentType.set}
                placeholder="image/png"
              />
            </View>
          </If>
          <Field
            label="有效期（秒）"
            keyboard="numeric"
            value={expiresIn()}
            onChange={expiresIn.set}
          />
          <Field
            label="终态回调地址"
            keyboard="url"
            value={callback()}
            onChange={callback.set}
          />
          <Field
            label="扩展字段（JSON）"
            multiline
            value={extras()}
            onChange={extras.set}
          />
          <Toggle label="提交后等待结果" checked={wait()} onChange={wait.set} />
          <StrategyEditor draft={strategy} optional />
        </Panel>
      </If>
    </WorkspacePage>
  );
}
