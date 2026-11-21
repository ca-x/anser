import { t } from "nsh/i18n";
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

const formats = () => [
  { value: "text", title: t("common.plain_text") },
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
      next.url = optionalHttpUrl(link(), t("compose.notification_link"));
      next.level = level();
      if (topic() && topicPassword()) next.topic_password = topicPassword();
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
      title={t("compose.send_notification")}
      footer={
        <View class="flex-row flex-wrap items-center justify-between gap-3">
          <Hint>
            {topic()
              ? t("common.topic_name_value", { name: topic() })
              : targets().length
                ? t("compose.target_count", { count: targets().length })
                : t("compose.use_default_routing")}
          </Hint>
          <Action
            label={
              delivery.busy()
                ? t("compose.submitting")
                : t("compose.send_notification")
            }
            onPress={send}
            kind="primary"
            disabled={delivery.busy() || !title().trim() || !body().trim()}
          />
        </View>
      }
    >
      <Problem message={delivery.problem()} />
      <Section title={t("compose.recipients")}>
        <Choice
          label="Topic"
          value={topic()}
          items={[
            { value: "", title: t("common.direct_delivery") },
            ...topics.items().map((item) => ({
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
            label={t("compose.topic_password_if_needed")}
            masked
            value={topicPassword()}
            onChange={topicPassword.set}
          />
        </If>
        <If when={topics.next()}>
          <Action
            label={t("compose.load_more_topics")}
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
          label={t("common.title")}
          value={title()}
          onChange={title.set}
          placeholder={t("compose.notification_title")}
          disabled={delivery.busy()}
        />
        <Field
          label={t("common.body")}
          value={body()}
          onChange={body.set}
          placeholder={t("compose.write_a_notification")}
          autoCapitalize="sentences"
          multiline
          disabled={delivery.busy()}
        />
        <Choice
          label={t("common.body_format")}
          items={formats()}
          value={format()}
          onChange={(value) => format.set((value ?? "text") as Format)}
        />
      </Panel>
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
          <StrategyEditor draft={strategy} optional />
        </Panel>
      </If>
    </WorkspacePage>
  );
}
