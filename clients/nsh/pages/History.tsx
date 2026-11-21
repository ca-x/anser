import { t } from "nsh/i18n";
import { cleanup, effect, resource, signal, Text, View } from "nsh";
import { channelName } from "../channelNames";
import { messageFor, type AnserApi } from "../api";
import type { Channel, Delivery } from "../contracts";
import {
  Action,
  confirm,
  Hint,
  Panel,
  Problem,
  ReadState,
  Section,
  Toggle,
} from "../components/Controls";
import {
  activeStatus,
  DeliveryStatus,
  localTime,
} from "../components/DeliveryStatus";
import { RecordRow, WorkspacePage } from "../components/Workspace";
import { operation, paged } from "../state";

export function History(props: {
  api: AnserApi;
  onOpen: (id: string) => void;
}) {
  const list = paged(props.api.history.bind(props.api));
  return (
    <WorkspacePage title={t("history.delivery_history")}>
      <Action
        label={t("common.refresh")}
        onPress={list.reload}
        kind="quiet"
        disabled={list.loading()}
        class="self-start"
      />
      <ReadState
        loading={list.loading()}
        problem={list.problem()}
        empty={!list.items().length}
        emptyLabel={t("history.no_notification_deliveries_yet")}
      />
      <Each of={list.items()} key={(message) => message.id}>
        {(message) => (
          <RecordRow
            title={message().message?.title || message().id}
            subtitle={`${message().topic ?? t("common.direct_delivery")} / ${localTime(message().created_at)}`}
            onPress={() => props.onOpen(message().id)}
            status={<DeliveryStatus value={message().status} />}
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

function DeliveryRecord(props: { delivery: Delivery; channels: Channel[] }) {
  const expanded = signal(false);
  const data = () => props.delivery;
  const channel = () =>
    channelName(
      data().channel,
      props.channels.find((entry) => entry.id === data().channel)?.display_name,
    );
  return (
    <Panel>
      <View class="flex-row flex-wrap items-center justify-between gap-2">
        <Text class="text-base font-medium text-foreground">{channel()}</Text>
        <DeliveryStatus value={data().status} />
      </View>
      <Hint>{t("history.account_value", { account: data().account_id })}</Hint>
      <If when={data().next_retry_at != null}>
        <Hint>
          {t("history.next_retry_time", {
            time: localTime(data().next_retry_at),
          })}
        </Hint>
      </If>
      <If when={(data().attempts?.length ?? 0) > 0}>
        <Action
          label={
            expanded()
              ? t("history.hide_attempts")
              : t("history.view_attempts", {
                  count: data().attempts?.length ?? 0,
                })
          }
          class="self-start"
          kind="quiet"
          onPress={() => expanded.update((value) => !value)}
        />
        <If when={expanded()}>
          <View class="gap-2">
            <Each of={data().attempts ?? []} key={(attempt) => attempt.n}>
              {(attempt) => (
                <View class="gap-1 border-t border-border pt-2">
                  <Text class="text-sm font-medium text-foreground">
                    {t("history.attempt_number", { number: attempt().n })}
                  </Text>
                  <Hint>
                    {t("history.attempt_time_range", {
                      start: localTime(attempt().started_at),
                      finish: localTime(attempt().finished_at),
                    })}
                  </Hint>
                  <If when={attempt().latency != null}>
                    <Hint>
                      {t("history.attempt_duration", {
                        duration: attempt().latency,
                      })}
                    </Hint>
                  </If>
                  <If when={attempt().error_code || attempt().error_msg}>
                    <Text class="text-sm text-destructive">
                      {[attempt().error_code, attempt().error_msg]
                        .filter(Boolean)
                        .join(" / ")}
                    </Text>
                  </If>
                </View>
              )}
            </Each>
          </View>
        </If>
      </If>
    </Panel>
  );
}

export function MessageDetail(props: {
  api: AnserApi;
  channels: Channel[];
  id: string;
  onBack: () => void;
  onReplay?: (id: string) => void;
}) {
  const current = resource(
    () => props.id,
    (id, { signal: abort }) => props.api.message(id, abort),
  );
  const auto = signal(true);
  const replay = operation();
  let replayKey: string | undefined;
  const active = () => {
    const message = current();
    return (
      !!message &&
      (activeStatus(message.status) ||
        (message.deliveries ?? []).some((item) => activeStatus(item.status)))
    );
  };
  effect(() => {
    if (!auto() || !active()) return;
    const timer = setInterval(() => {
      const state = current.state();
      if (state !== "pending" && state !== "refreshing") void current.refetch();
    }, 4000);
    cleanup(() => clearInterval(timer));
  });
  function retry() {
    void replay.run(async () => {
      if (
        !(await confirm(
          t("history.replay_notification"),
          t("history.the_server_will_create_a_new"),
          t("history.replay_notification_2"),
          false,
        ))
      )
        return;
      replayKey ??= crypto.randomUUID();
      const result = await props.api.replay(props.id, replayKey);
      replayKey = undefined;
      if (replay.live()) props.onReplay?.(result.message_id);
    });
  }
  return (
    <WorkspacePage title={t("history.delivery_details")} back={props.onBack}>
      <View class="flex-row flex-wrap items-center justify-between gap-2">
        <Action
          label={t("common.refresh")}
          kind="quiet"
          onPress={current.refetch}
          disabled={
            current.state() === "pending" || current.state() === "refreshing"
          }
        />
        <If when={active()}>
          <Toggle
            label={t("history.auto_refresh")}
            checked={auto()}
            onChange={auto.set}
          />
        </If>
      </View>
      <Problem message={replay.problem()} />
      <ReadState
        loading={
          current.state() === "pending" || current.state() === "refreshing"
        }
        problem={current.error() ? messageFor(current.error()) : ""}
        empty={!current()}
        emptyLabel={t("history.this_message_could_not_be_found")}
      />
      <If when={current()}>
        {(message) => (
          <View class="gap-5">
            <Panel>
              <View class="flex-row flex-wrap items-center justify-between gap-2">
                <Text
                  role="header"
                  class="text-[19px] font-semibold text-foreground"
                >
                  {message().message?.title || t("history.notification")}
                </Text>
                <DeliveryStatus value={message().status} />
              </View>
              <Hint>
                {message().topic ?? t("common.direct_delivery")} /{" "}
                {localTime(message().created_at)}
              </Hint>
              <View selectable>
                <Text class="text-sm text-foreground">{message().id}</Text>
              </View>
              <View selectable>
                <Text class="text-sm leading-5 text-foreground">
                  {message().message?.body}
                </Text>
              </View>
            </Panel>
            <Section title={t("history.channel_deliveries")}>
              <If when={!message().deliveries?.length}>
                <Hint>{t("history.no_channel_deliveries_yet")}</Hint>
              </If>
              <Each
                of={message().deliveries ?? []}
                key={(delivery) => delivery.id}
              >
                {(delivery) => (
                  <DeliveryRecord
                    delivery={delivery()}
                    channels={props.channels}
                  />
                )}
              </Each>
            </Section>
            <If
              when={
                props.onReplay &&
                (["failed", "dead"].includes(message().status) ||
                  message().deliveries?.some((delivery) =>
                    ["failed", "dead"].includes(delivery.status),
                  ))
              }
            >
              <Action
                label={
                  replay.busy()
                    ? t("history.replaying")
                    : t("history.replay_notification_2")
                }
                onPress={retry}
                disabled={replay.busy()}
                class="self-start"
              />
            </If>
          </View>
        )}
      </If>
    </WorkspacePage>
  );
}
