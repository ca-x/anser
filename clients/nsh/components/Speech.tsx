import { AudioPlayer, cleanup, platform, signal, Text, View } from "nsh";
import { t } from "nsh/i18n";
import { LinuxAudio } from "anser-native";
import type { InboxItem } from "../contracts";
import type { Preferences } from "../preferences";
import { Action, Problem } from "./Controls";

const audioPath = /^\/v1\/speech\/audio\/[A-Za-z0-9_-]{43}\.mp3$/;
export function canPlaySpeech(path: unknown): path is string {
  return typeof path === "string" && path.endsWith(".mp3") && audioPath.test(path);
}

export function speechBody(body: string, path?: string) {
  if (!canPlaySpeech(path)) return body;
  const separator = body.indexOf("\n\n");
  if (separator === -1) return body;
  const link = body.slice(0, separator);
  return link.startsWith("https://") && link.endsWith(path) ? body.slice(separator + 2) : body;
}

const maxPending = 16;
const maxAudioBytes = 4 * 1024 * 1024;
const loadTimeout = 15_000;
const playbackTimeout = 600_000;

type LinuxFallback = { abort: AbortController; player?: LinuxAudio };

type Recording = { origin: string; url: string; title: string; autoplay: boolean };
type Playback = Recording & { sequence: number; phase: "loading" | "playing" };

async function readSpeech(url: string, signal: AbortSignal) {
  const response = await fetch(url, { signal, redirect: "error" });
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (!response.ok || mediaType !== "audio/mpeg" || Number(response.headers.get("content-length")) > maxAudioBytes) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error("Speech recording unavailable");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing speech recording");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > maxAudioBytes) throw new Error("Speech recording too large");
      chunks.push(result.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (!length) throw new Error("Missing speech recording");
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function speechPlayback(preferences: Preferences) {
  const active = signal<Playback | undefined>(undefined);
  const failure = signal<Recording | undefined>(undefined);
  const auto = () => preferences.settings().speechAutoplay !== false;
  const pending: Recording[] = [];
  let sequence = 0;
  let player: AudioPlayer | undefined;
  let fallback: LinuxFallback | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function recording(origin: string, item: { title: string; audio_path?: string }, autoplay: boolean): Recording | undefined {
    if (!canPlaySpeech(item.audio_path)) return undefined;
    return { origin, url: origin + item.audio_path, title: item.title, autoplay };
  }

  function playing(id: number) {
    const current = active();
    if (current?.sequence !== id) return;
    clearTimeout(timer);
    timer = setTimeout(() => finish(id, true), playbackTimeout);
    active.set({ ...current, phase: "playing" });
  }

  function start(next?: Recording) {
    clearTimeout(timer);
    const id = ++sequence;
    active.set(next ? { ...next, sequence: id, phase: "loading" } : undefined);
    player?.dispose();
    player = undefined;
    fallback?.abort.abort();
    fallback?.player?.stop();
    fallback?.player?.dispose();
    fallback = undefined;
    if (!next) return;
    const { url } = next;

    function failed(error?: unknown) {
      if (active()?.sequence !== id || fallback) return;
      const code = typeof error === "object" && error && "code" in error ? error.code : undefined;
      if (platform.os !== "linux" || code === "not-allowed" || code === "ERR_ACCESS_DENIED") {
        finish(id, true);
        return;
      }
      const state: LinuxFallback = { abort: new AbortController() };
      fallback = state;
      player?.dispose();
      player = undefined;
      const current = active();
      if (current?.sequence === id) active.set({ ...current, phase: "loading" });
      clearTimeout(timer);
      timer = setTimeout(() => finish(id, true), loadTimeout);
      void readSpeech(url, state.abort.signal).then(async (bytes) => {
        if (state.abort.signal.aborted) return;
        const audio = new LinuxAudio();
        state.player = audio;
        await audio.play(bytes, () => playing(id));
        finish(id);
      }).catch(() => finish(id, true));
    }

    timer = setTimeout(() => failed(), loadTimeout);
    try {
      const audio = new AudioPlayer(url);
      player = audio;
      audio.on("end", () => { if (!fallback) finish(id); });
      audio.on("error", failed);
      void audio.play().then(() => {
        if (!fallback) playing(id);
      }, failed);
      if (platform.os === "linux") {
        // Give working players a chance to report that playback started, even
        // when their host handles audio in place of GTK.
        void LinuxAudio.gtkMp3Available().then((available) => {
          const current = active();
          if (available || fallback || current?.sequence !== id || current.phase !== "loading") return;
          clearTimeout(timer);
          timer = setTimeout(() => failed(), 350);
        }).catch(() => undefined);
      }
    } catch (error) {
      failed(error);
    }
  }

  function finish(id: number, failed = false) {
    const current = active();
    if (current?.sequence !== id) return;
    if (failed) failure.set(current);
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
    failure,
    dismiss: () => failure.set(undefined),
    retry() {
      const item = failure();
      if (!item) return;
      failure.set(undefined);
      start({ ...item, autoplay: false });
    },
    stop,
    forget(origin: string) {
      for (let index = pending.length - 1; index >= 0; index--) {
        if (pending[index].origin === origin) pending.splice(index, 1);
      }
      if (failure()?.origin === origin) failure.set(undefined);
      if (active()?.origin === origin) start(pending.shift());
    },
    changeAuto(enabled: boolean) {
      preferences.changeSpeechAutoplay(enabled);
      if (enabled) return;
      pending.length = 0;
      if (active()?.autoplay) start();
    },
    received(origin: string, items: InboxItem[]): ReadonlySet<number> {
      const queued = new Set<number>();
      if (!preferences.ready() || !auto()) return queued;
      for (const item of items) {
        if (pending.length >= maxPending) break;
        const next = recording(origin, item, true);
        if (!next) continue;
        pending.push(next);
        queued.add(item.id);
      }
      if (!active() && pending.length) start(pending.shift());
      return queued;
    },
    replay(origin: string, item: { title: string; audio_path?: string }) {
      const next = recording(origin, item, false);
      if (!next) return;
      failure.set(undefined);
      start(next);
    },
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
        <View class="flex-row items-center gap-2 border-b border-border bg-card px-4 py-1.5" testID={playback().phase === "playing" ? "speech-playing" : "speech-loading"}>
          <View class="min-w-0 flex-1">
            <Text class="text-xs text-muted-foreground">{t(playback().phase === "playing" ? "speech.playing" : "speech.loading")}</Text>
            <Text class="line-clamp-1 text-sm font-semibold text-foreground">{playback().title || t("speech.notification")}</Text>
          </View>
          <Action label={t("speech.stop")} kind="quiet" onPress={state.stop} />
        </View>
      )}
    </Each>
    <If when={state.failure()}>
      <View class="gap-2 border-b border-border bg-card px-4 py-1.5 md:flex-row md:items-center">
        <View class="min-w-0 flex-1"><Problem message={t("speech.playback_failed")} /></View>
        <View class="flex-row flex-wrap justify-end gap-2">
          <Action label={t("speech.retry")} onPress={state.retry} />
          <Action label={t("speech.dismiss")} kind="quiet" onPress={state.dismiss} />
        </View>
      </View>
    </If>
  </>;
}
