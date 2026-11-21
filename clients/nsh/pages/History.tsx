import { cleanup, effect, resource, signal, Text, View } from "nsh";
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
    <WorkspacePage title="投递记录">
      <Action
        label="刷新"
        onPress={list.reload}
        kind="quiet"
        disabled={list.loading()}
        class="self-start"
      />
      <ReadState
        loading={list.loading()}
        problem={list.problem()}
        empty={!list.items().length}
        emptyLabel="还没有通知的投递记录。"
      />
      <Each of={list.items()} key={(message) => message.id}>
        {(message) => (
          <RecordRow
            title={message().message?.title || message().id}
            subtitle={`${message().topic ?? "直接投递"} / ${localTime(message().created_at)}`}
            onPress={() => props.onOpen(message().id)}
            status={<DeliveryStatus value={message().status} />}
          />
        )}
      </Each>
      <If when={list.next()}>
        <Action
          label="加载更多"
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
    props.channels.find((entry) => entry.id === data().channel)?.display_name ??
    data().channel;
  return (
    <Panel>
      <View class="flex-row flex-wrap items-center justify-between gap-2">
        <Text class="text-base font-medium text-foreground">{channel()}</Text>
        <DeliveryStatus value={data().status} />
      </View>
      <Hint>账号：{data().account_id}</Hint>
      <If when={data().next_retry_at != null}>
        <Hint>下次重试：{localTime(data().next_retry_at)}</Hint>
      </If>
      <If when={(data().attempts?.length ?? 0) > 0}>
        <Action
          label={
            expanded()
              ? "收起尝试记录"
              : `查看 ${data().attempts?.length ?? 0} 次尝试`
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
                    第 {attempt().n} 次尝试
                  </Text>
                  <Hint>
                    开始：{localTime(attempt().started_at)}　结束：
                    {localTime(attempt().finished_at)}
                  </Hint>
                  <If when={attempt().latency != null}>
                    <Hint>耗时：{attempt().latency} 毫秒</Hint>
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
          "重放通知？",
          "服务器将创建新的投递请求。",
          "重放通知",
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
    <WorkspacePage title="投递详情" back={props.onBack}>
      <View class="flex-row flex-wrap items-center justify-between gap-2">
        <Action
          label="刷新"
          kind="quiet"
          onPress={current.refetch}
          disabled={
            current.state() === "pending" || current.state() === "refreshing"
          }
        />
        <If when={active()}>
          <Toggle label="自动刷新" checked={auto()} onChange={auto.set} />
        </If>
      </View>
      <Problem message={replay.problem()} />
      <ReadState
        loading={
          current.state() === "pending" || current.state() === "refreshing"
        }
        problem={current.error() ? messageFor(current.error()) : ""}
        empty={!current()}
        emptyLabel="找不到这条消息。"
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
                  {message().message?.title || "通知"}
                </Text>
                <DeliveryStatus value={message().status} />
              </View>
              <Hint>
                {message().topic ?? "直接投递"} /{" "}
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
            <Section title="渠道投递">
              <If when={!message().deliveries?.length}>
                <Hint>暂时没有渠道投递记录。</Hint>
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
                label={replay.busy() ? "正在重放…" : "重放通知"}
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
