import { speechBody, type SpeechPlayback } from "../components/Speech";
import { t } from "nsh/i18n";
import { cleanup, effect, reduceMotion, resource, Scroll, signal, Text, View, windowSize } from "nsh";
import { Dialog } from "nsh/base";
import { channelName } from "../channelNames";
import { messageFor, type AnserApi } from "../api";
import type { Channel, Delivery, HistoryEntry } from "../contracts";
import {
  Action,
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
import {
  messagePreview,
  RecordRow,
  WorkspacePage,
} from "../components/Workspace";
import { operation, paged } from "../state";

function destination(message: HistoryEntry) {
  if (message.inbox_recipient)
    return t("history.to_user", { username: message.inbox_recipient });
  return message.topic ?? t("common.direct_delivery");
}

function inboxReceipt(message: HistoryEntry) {
  const count = message.inbox_deliveries ?? 0;
  if (count < 1) return;
  if (message.inbox_recipient)
    return t("history.delivered_to_user", {
      username: message.inbox_recipient,
    });
  return count === 1
    ? t("history.one_inbox_delivery")
    : t("history.inbox_delivery_count", { count });
}

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
            title={messagePreview(message().message) ?? message().id}
            subtitle={`${destination(message())} / ${localTime(message().created_at)}`}
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
        <DeliveryStatus
          value={
            data().next_retry_at != null && data().status === "pending"
              ? "waiting"
              : data().status
          }
        />
      </View>
      <Hint>{t("history.account_value", { account: data().account_name ?? data().account_id })}</Hint>
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
  speech: SpeechPlayback;
}) {
  const current = resource(
    () => props.id,
    (id, { signal: abort }) => props.api.message(id, abort),
  );
  const auto = signal(true);
  const replay = operation();
  const choosing = signal(false);
  const selected = signal<string[]>([]);
  let lastRequest: { selection: string; key: string } | undefined;
  const targets = () => (current()?.deliveries ?? []).filter((d) =>
    ["success", "failed", "dead"].includes(d.status),
  );
  const failures = () => targets().filter((d) => d.status !== "success");
  const successes = () => targets().filter((d) => d.status === "success");
  const mixed = () => failures().length > 0 && successes().length > 0;
  const name = (d: Delivery) => channelName(d.channel, props.channels.find((c) => c.id === d.channel)?.display_name);
  function targetLabel(d: Delivery) {
    const account = d.account_name ?? d.account_id;
    return [name(d), account, d.subscription_id].filter(Boolean).join(" · ");
  }
  function openReplay() {
    selected.set((failures().length ? failures() : successes()).map((d) => d.id));
    replay.problem.set("");
    choosing.set(true);
  }
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
      const ids = [...selected()].sort();
      const selection = JSON.stringify([props.id, ids]);
      if (lastRequest?.selection !== selection) {
        lastRequest = { selection, key: crypto.randomUUID() };
      }
      const result = await props.api.replay(props.id, lastRequest.key, ids);
      lastRequest = undefined;
      choosing.set(false);
      if (replay.live()) props.onReplay?.(result.message_id);
    });
  }
  return (
    <WorkspacePage
      title={t("history.delivery_details")}
      back={props.onBack}
      headerAction={
        <Action
          label={t("common.refresh")}
          kind="quiet"
          onPress={current.refetch}
          disabled={
            current.state() === "pending" || current.state() === "refreshing"
          }
        />
      }
    >

      <ReadState
        loading={!current() && current.state() === "pending"}
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
                  class="min-w-0 flex-1 text-[19px] font-semibold text-foreground"
                >
                  {message().message?.title || t("history.notification")}
                </Text>
                <DeliveryStatus value={message().status} />
              </View>
              <Hint>
                {message().inbox_recipient
                  ? ""
                  : `${destination(message())} / `}
                {localTime(message().created_at)}
              </Hint>
              <If when={speechBody(message().message?.body ?? "", message().audio_path)}>
                {(body) => (
                  <View selectable>
                    <Text class="text-base leading-6 text-foreground">
                      {body()}
                    </Text>
                  </View>
                )}
              </If>
              <If when={message().audio_path}>
                {(path) => <Action label={t("speech.play")} class="self-start"
                  onPress={() => props.speech.replay(props.api.origin, { audio_path: path(), title: message().message?.title ?? "" })} />}
              </If>
              <View class="gap-1.5 border-t border-border pt-3">
                <If when={inboxReceipt(message())}>
                  {(receipt) => (
                    <Text class="text-sm font-medium text-success">
                      {receipt()}
                    </Text>
                  )}
                </If>
                <View selectable>
                  <Hint>{t("history.message_id", { id: message().id })}</Hint>
                </View>
              </View>
            </Panel>
            <If
              when={
                Boolean(message().deliveries?.length) ||
                !message().inbox_deliveries
              }
            >
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
            </If>
            <If when={active()}>
              <Toggle
                label={t("history.auto_refresh")}
                checked={auto()}
                onChange={auto.set}
              />
            </If>
            <If
              when={
                props.onReplay && !message().history_deleted && !active() && targets().length > 0
              }
            >
              <Action
                label={
                  replay.busy()
                    ? t("history.replaying")
                    : t("history.replay_notification_2")
                }
                onPress={openReplay}
                disabled={replay.busy()}
                class="self-start"
              />
            </If>
            <If when={choosing()}>
              <Dialog
                accessibilityLabel={t("history.replay_notification")}
                animation={reduceMotion() ? "none" : "fade"}
                presentation="formSheet"
                backdropClass="bg-foreground/30"
                class="m-auto w-11/12 max-w-md rounded-(--radius) border border-border bg-popover"
                closeOnSwipe={!replay.busy()}
                closeOnEscape={!replay.busy()}
                closeOnBackdropPress={!replay.busy()}
                onOpenChange={({ open }) => { if (!open) choosing.set(false); }}
              >
                <Scroll style={{ maxHeight: Math.floor(windowSize().height * 0.8) }}>
                  <View class="gap-4 p-5">
                    <Text role="header" class="text-xl font-semibold text-foreground">
                      {mixed() ? t("history.replay_notification") : t("history.replay_targets", { targets: [...new Set(targets().map(name))].join(" / ") })}
                    </Text>
                    <If when={mixed()}>
                      <Each of={[
                        { title: t("history.replay_failed_group"), items: failures() },
                        { title: t("history.replay_success_group"), items: successes() },
                      ]} key={(group) => group.title}>
                        {(group) => (
                          <Section title={group().title}>
                            <Each of={group().items} key={(item) => item.id}>
                              {(item) => (
                                <Toggle
                                  label={targetLabel(item())}
                                  checked={selected().includes(item().id)}
                                  disabled={replay.busy()}
                                  onChange={(enabled) => selected.update((ids) => enabled ? [...ids, item().id] : ids.filter((id) => id !== item().id))}
                                />
                              )}
                            </Each>
                          </Section>
                        )}
                      </Each>
                    </If>
                    <Problem message={replay.problem()} />
                    <View class="flex-row flex-wrap gap-2">
                      <Action label={t("common.cancel")} kind="quiet" disabled={replay.busy()} onPress={() => choosing.set(false)} />
                      <Action label={t("history.replay_confirm")} onPress={retry} disabled={!selected().length || replay.busy()} />
                    </View>
                  </View>
                </Scroll>
              </Dialog>
            </If>
          </View>
        )}
      </If>
    </WorkspacePage>
  );
}
