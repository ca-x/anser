import { cleanup, signal, Text, Video, View } from "nsh";
import { t } from "nsh/i18n";
import type { InboxItem } from "../contracts";
import { Action, Problem } from "./Controls";

const audioPath = /^\/v1\/speech\/audio\/[A-Za-z0-9_-]{43}\.mp3$/;
const maxPending = 16;
const loadTimeout = 15_000;
const playbackTimeout = 600_000;

type Playback = { url: string; title: string; sequence: number };

export function speechPlayback(origin: string) {
  const active = signal<Playback | undefined>(undefined);
  const problem = signal("");
  const auto = signal(true);
  const pending: Playback[] = [];
  let sequence = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function playback(item: InboxItem) {
    if (!item.audio_path?.endsWith(".mp3") || !audioPath.test(item.audio_path)) return undefined;
    return { url: origin + item.audio_path, title: item.title, sequence: ++sequence };
  }

  function start(next?: Playback) {
    clearTimeout(timer);
    active.set(next);
    if (next) timer = setTimeout(() => finish(next.sequence, true), loadTimeout);
  }

  function finish(id: number, failed = false) {
    if (active()?.sequence !== id) return;
    if (failed) problem.set(t("speech.playback_failed"));
    start(pending.shift());
  }

  function stop() {
    pending.length = 0;
    start();
  }

  cleanup(stop);
  return {
    active,
    auto,
    problem,
    dismiss: () => problem.set(""),
    stop,
    changeAuto(enabled: boolean) {
      auto.set(enabled);
      if (!enabled) stop();
    },
    received(items: InboxItem[]) {
      if (!auto()) return;
      for (const item of items) {
        const next = playback(item);
        if (next && pending.length < maxPending) pending.push(next);
      }
      if (!active() && pending.length) start(pending.shift());
    },
    replay(item: InboxItem) {
      const next = playback(item);
      if (!next) return;
      problem.set("");
      start(next);
    },
    loaded(id: number) {
      if (active()?.sequence !== id) return;
      clearTimeout(timer);
      timer = setTimeout(() => finish(id, true), playbackTimeout);
    },
    finish,
  };
}

export type SpeechPlayback = ReturnType<typeof speechPlayback>;

export function SpeechPlayer(props: { state: SpeechPlayback }) {
  const state = props.state;
  const active = () => {
    const playback = state.active();
    return playback ? [playback] : [];
  };
  return <>
    <Each of={active()} key={(playback) => playback.sequence}>
      {(playback) => (
        <View class="flex-row items-center gap-2 border-b border-border bg-card px-4 py-1.5" testID="speech-playing">
          <Video src={playback().url} paused={false}
            class="size-px opacity-0" accessibilityElementsHidden
            onLoad={() => state.loaded(playback().sequence)}
            onEnd={() => state.finish(playback().sequence)}
            onError={() => state.finish(playback().sequence, true)} />
          <Text class="flex-1 text-sm font-semibold text-foreground">
            {playback().title || t("speech.notification")}
          </Text>
          <Action label={t("speech.stop")} kind="quiet" onPress={state.stop} />
        </View>
      )}
    </Each>
    <If when={state.problem()}>
      <View class="flex-row items-center gap-2 border-b border-border bg-card px-4 py-1.5">
        <View class="flex-1"><Problem message={state.problem()} /></View>
        <Action label={t("speech.dismiss")} kind="quiet" onPress={state.dismiss} />
      </View>
    </If>
  </>;
}
