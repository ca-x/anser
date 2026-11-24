import { t } from "nsh/i18n";
import { announce, cleanup, effect, lifecycle, Notifications, platform, signal, wakeCount } from "nsh";
import type { Preferences } from "./preferences";
import { ApiError, messageFor, type AnserApi } from "./api";
import type { InboxItem } from "./contracts";

// Some desktops retain notifications after app exit. Do not route them to a
// new session that happens to reuse the same local session and message IDs.
const noticePrefix = `inbox:${crypto.randomUUID()}:`;

export function inboxNoticeId(sessionId: number, id?: number) {
  return `${noticePrefix}${sessionId}:${id ?? "batch"}`;
}

export function decodeInboxNoticeId(notice: string) {
  if (!notice.startsWith(noticePrefix)) return undefined;
  const match = /^(\d+):(batch|\d+)$/.exec(notice.slice(noticePrefix.length));
  if (!match) return undefined;
  const sessionId = Number(match[1]);
  const id = match[2] === "batch" ? undefined : Number(match[2]);
  if (!Number.isSafeInteger(sessionId) || (id !== undefined && !Number.isSafeInteger(id))) return undefined;
  if (inboxNoticeId(sessionId, id) !== notice) return undefined;
  return { sessionId, id };
}

export function systemNotifications(
  preferences: Preferences,
  onPress: (noticeId: string) => void,
  unread: () => number,
) {
  const native = signal(false);
  const enabled = () => preferences.settings().systemNotifications === true;
  const nativeMessage = signal("");
  const testingNative = signal(false);
  const testAccepted = signal(false);
  const checkingPermission = signal(false);
  const groups = new Map<number, Set<number>>();
  let live = true;
  let permissionRevision = 0;
  try {
    cleanup(Notifications.on("press", ({ id }) => onPress(id)));
  } catch {
    // Embedding hosts can deny notifications while leaving the inbox available.
  }
  cleanup(() => {
    live = false;
    if (native()) {
      void Notifications.setBadge(0).catch(() => undefined);
      void Notifications.closeAll().catch(() => undefined);
    }
  });

  async function show(id: string, body: string, silent = false) {
    try {
      if (await Notifications.show({ id, title: t("inbox.new_anser_notification"), body, silent }))
        return true;
    } catch {
      // Report a failed submission even when the platform rejects it.
    }
    if (live && native()) nativeMessage.set(t("inbox.system_notification_failed"));
    return false;
  }

  async function checkPermission(request: boolean) {
    const revision = ++permissionRevision;
    checkingPermission.set(true);
    const previous = native();
    const permission = await (request ? Notifications.requestPermission() : Notifications.permission())
      .catch(() => "unavailable");
    if (!live || revision !== permissionRevision) return false;
    checkingPermission.set(false);
    native.set(permission === "granted");
    if (permission === "granted") {
      nativeMessage.set("");
      return true;
    }
    if (previous) void Notifications.setBadge(0).catch(() => undefined);
    testAccepted.set(false);
    nativeMessage.set(t(permission === "denied"
      ? "inbox.system_notification_permission_was_denied_you"
      : "inbox.system_notifications_are_unavailable_in_this"));
    return false;
  }

  let lastWake: number | undefined;
  let wasActive = false;
  effect(() => {
    if (!preferences.ready()) return;
    const wake = wakeCount();
    const active = lifecycle() === "active";
    const resumed = (active && !wasActive) || wake !== lastWake;
    wasActive = active;
    lastWake = wake;
    if (resumed && enabled() && !checkingPermission()) void checkPermission(false);
  });
  effect(() => {
    if (native()) void Notifications.setBadge(unread()).catch(() => undefined);
  });

  function close(id: string) {
    if (enabled()) void Notifications.close(id).catch(() => undefined);
  }

  return {
    enabled,
    native,
    nativeMessage,
    checkingPermission,
    testingNative,
    testAccepted,
    read(sessionId: number, id: number) {
      close(inboxNoticeId(sessionId, id));
      const group = groups.get(sessionId);
      if (!group?.delete(id) || group.size) return;
      groups.delete(sessionId);
      close(inboxNoticeId(sessionId));
    },
    forget(sessionId: number, unread: InboxItem[]) {
      for (const item of unread) close(inboxNoticeId(sessionId, item.id));
      if (groups.delete(sessionId)) close(inboxNoticeId(sessionId));
    },
    received(sessionId: number, items: InboxItem[], queuedAudioIds: ReadonlySet<number>) {
      if (!enabled() || !native() || !items.length) return;
      // A silent Android channel also suppresses the banner.
      const silent = platform.os !== "android" && items.every((item) => queuedAudioIds.has(item.id));
      if (items.length === 1) {
        void show(inboxNoticeId(sessionId, items[0].id), t("inbox.open_anser_to_view_it"), silent);
        return;
      }
      const group = groups.get(sessionId) ?? new Set<number>();
      for (const item of items) group.add(item.id);
      groups.set(sessionId, group);
      void show(inboxNoticeId(sessionId), t("inbox.new_count", { count: group.size }), silent);
    },
    async changeNative(enabled: boolean) {
      nativeMessage.set("");
      testAccepted.set(false);
      preferences.changeSystemNotifications(enabled);
      if (enabled) {
        await checkPermission(true);
      } else {
        permissionRevision += 1;
        checkingPermission.set(false);
        native.set(false);
        groups.clear();
        void Promise.allSettled([Notifications.setBadge(0), Notifications.closeAll()]);
      }
    },
    async testNative() {
      if (!enabled() || testingNative() || checkingPermission()) return;
      nativeMessage.set("");
      testAccepted.set(false);
      testingNative.set(true);
      try {
        if (!native() && !(await checkPermission(false))) return;
        if (!enabled() || !live) return;
        const accepted = await show("inbox-test", t("inbox.system_notification_test_body"));
        if (live && native()) testAccepted.set(accepted);
      } finally {
        if (live) testingNative.set(false);
      }
    },
  };
}

export type SystemNotifications = ReturnType<typeof systemNotifications>;

export function inboxState(
  api: AnserApi,
  onReceive: (items: InboxItem[]) => void,
  notifications: SystemNotifications,
  sessionId: number,
) {
  const items = signal<InboxItem[]>([]);
  const loading = signal(true);
  const problem = signal("");
  const unread = () => items().filter((item) => item.read_at == null).length;
  let cursor: string | null = null;
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let subscribed = true;
  let initialized = false;
  let failures = 0;

  cleanup(() => {
    subscribed = false;
    clearTimeout(timer);
    controller?.abort();
    notifications.forget(sessionId, items().filter((item) => item.read_at == null));
  });

  async function poll(wait: boolean) {
    if (!subscribed) return;
    if (!wait) loading.set(true);
    clearTimeout(timer);
    controller?.abort();
    const abort = new AbortController();
    controller = abort;
    let delay = 250;
    try {
      const metadata = !wait && cursor !== null
        ? api.inbox(null, false, abort.signal).catch(() => undefined)
        : undefined;
      const page = await api.inbox(cursor, wait, abort.signal);
      const latest = metadata && await metadata;
      if (abort.signal.aborted) return;
      problem.set("");
      failures = 0;
      cursor = page.next_cursor ?? cursor;
      const previous = items();
      const known = new Map(previous.map((item) => [item.id, item]));
      const fresh = page.items.filter((item) => !known.has(item.id));
      for (const item of page.items) {
        const cached = known.get(item.id);
        known.set(item.id, {
          ...item,
          read_at: item.read_at ?? cached?.read_at,
        });
      }
      // Refresh already loaded rows without advancing the live cursor from
      // the trailing-window snapshot.
      for (const item of latest?.items ?? []) {
        const cached = known.get(item.id);
        if (!cached) continue;
        known.set(item.id, { ...item, read_at: item.read_at ?? cached.read_at });
        if (cached.read_at == null && item.read_at != null) notifications.read(sessionId, item.id);
      }
      items.set([...known.values()].sort((left, right) => right.id - left.id));
      const incoming = fresh.filter((item) => known.get(item.id)?.read_at == null);
      if (initialized && incoming.length) {
        onReceive(incoming);
        announce(t("inbox.new_count", { count: incoming.length }));
      }
      initialized = true;
    } catch (error) {
      if (abort.signal.aborted) return;
      problem.set(messageFor(error));
      failures = Math.min(failures + 1, 5);
      delay = error instanceof ApiError && error.status === 401
        ? 30_000
        : Math.min(30_000, 1500 * 2 ** failures) * (0.8 + Math.random() * 0.2);
    } finally {
      if (!abort.signal.aborted && subscribed) {
        loading.set(false);
        timer = setTimeout(() => void poll(true), delay);
      }
    }
  }

  async function markRead(id: number) {
    await api.readInbox(id);
    if (!subscribed) return;
    items.update((previous) =>
      previous.map((item) =>
        item.id === id
          ? { ...item, read_at: item.read_at ?? Date.now() }
          : item,
      ),
    );
    notifications.read(sessionId, id);
  }

  void poll(false);
  return {
    items,
    loading,
    problem,
    unread,
    markRead,
    // The initial page is a trailing window. Reuse the cursor so refreshing
    // during a burst never jumps past the unseen messages before that window.
    reload: () => poll(false),
  };
}

export type InboxState = ReturnType<typeof inboxState>;
