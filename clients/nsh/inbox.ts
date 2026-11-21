import { announce, cleanup, Notifications, signal } from "nsh";
import { ApiError, messageFor, type AnserApi } from "./api";
import type { InboxItem } from "./contracts";

export function inboxState(api: AnserApi, onOpen: (id: number) => void) {
  const items = signal<InboxItem[]>([]);
  const loading = signal(true);
  const problem = signal("");
  const native = signal(false);
  const nativeMessage = signal("");
  const unread = () => items().filter((item) => item.read_at == null).length;
  let cursor: string | null = null;
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let subscribed = true;
  let initialized = false;

  let stop: (() => void) | undefined;
  try {
    stop = Notifications.on("press", ({ id }) => {
      if (!id.startsWith("inbox:")) return;
      const itemId = Number(id.slice(6));
      if (items().some((item) => item.id === itemId)) onOpen(itemId);
    });
  } catch {
    // An embedding host can deny system notifications while leaving the inbox available.
  }

  cleanup(() => {
    subscribed = false;
    clearTimeout(timer);
    controller?.abort();
    stop?.();
    if (native()) {
      void Notifications.setBadge(0).catch(() => undefined);
      void Notifications.closeAll().catch(() => undefined);
    }
  });

  async function poll(wait: boolean) {
    if (!subscribed) return;
    clearTimeout(timer);
    controller?.abort();
    const abort = new AbortController();
    controller = abort;
    let delay = 250;
    try {
      const page = await api.inbox(cursor, wait, abort.signal);
      if (abort.signal.aborted) return;
      problem.set("");
      cursor = page.next_cursor ?? cursor;
      const previous = items();
      const known = new Map(previous.map((item) => [item.id, item]));
      const fresh = page.items.filter(
        (item) => item.read_at == null && !known.has(item.id),
      );
      for (const item of page.items) {
        const cached = known.get(item.id);
        known.set(item.id, {
          ...item,
          read_at: item.read_at ?? cached?.read_at,
        });
      }
      items.set([...known.values()].sort((left, right) => right.id - left.id));
      if (initialized && fresh.length) {
        announce(`收到 ${fresh.length} 条新通知。`);
        if (native()) {
          for (const item of fresh.slice(0, 4)) {
            void Notifications.show({
              id: `inbox:${item.id}`,
              title: "雁字新通知",
              body: "打开雁字查看详情。",
            }).catch(() => undefined);
          }
        }
      }
      if (native())
        void Notifications.setBadge(unread()).catch(() => undefined);
      initialized = true;
    } catch (error) {
      if (abort.signal.aborted) return;
      problem.set(messageFor(error));
      delay = error instanceof ApiError && error.status === 401 ? 30000 : 3500;
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
    if (native()) {
      void Notifications.close(`inbox:${id}`).catch(() => undefined);
      void Notifications.setBadge(unread()).catch(() => undefined);
    }
  }

  async function changeNative(enabled: boolean) {
    nativeMessage.set("");
    if (!enabled) {
      native.set(false);
      void Promise.allSettled([
        Notifications.setBadge(0),
        Notifications.closeAll(),
      ]);
      return;
    }
    try {
      const permission = await Notifications.requestPermission();
      if (!subscribed) return;
      native.set(permission === "granted");
      if (permission === "granted") {
        void Notifications.setBadge(unread()).catch(() => undefined);
      } else {
        nativeMessage.set(
          permission === "denied"
            ? "系统已拒绝通知权限，可在系统设置中修改。"
            : "当前平台或运行环境无法显示系统通知。",
        );
      }
    } catch {
      if (subscribed) nativeMessage.set("当前运行环境无法请求系统通知权限。");
    }
  }

  void poll(false);
  return {
    items,
    loading,
    problem,
    unread,
    native,
    nativeMessage,
    changeNative,
    markRead,
    reload: () => {
      cursor = null;
      return poll(false);
    },
  };
}

export type InboxState = ReturnType<typeof inboxState>;
