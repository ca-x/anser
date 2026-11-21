import { announce, cleanup, signal } from "nsh";
import { messageFor } from "./api";
import type { Page } from "./contracts";

export function operation() {
  const busy = signal(false);
  const problem = signal("");
  let live = true;
  cleanup(() => {
    live = false;
  });
  const run = async (action: () => Promise<void>) => {
    if (!live || busy()) return;
    busy.set(true);
    problem.set("");
    try {
      await action();
    } catch (error) {
      if (live) {
        const message = messageFor(error);
        problem.set(message);
        announce(message);
      }
    } finally {
      if (live) busy.set(false);
    }
  };
  return { busy, problem, run, live: () => live };
}

export function paged<T>(
  load: (cursor?: string | null, signal?: AbortSignal) => Promise<Page<T>>,
) {
  const items = signal<T[]>([]);
  const next = signal<string | null>(null);
  const loading = signal(false);
  const problem = signal("");
  let abort: AbortController | undefined;
  cleanup(() => abort?.abort());

  async function fetchPage(append = false) {
    const cursor = append ? next() : null;
    if (append && (!cursor || loading())) return;
    abort?.abort();
    const controller = new AbortController();
    abort = controller;
    loading.set(true);
    problem.set("");
    try {
      const page = await load(cursor, controller.signal);
      if (controller.signal.aborted) return;
      items.set(append ? [...items(), ...page.items] : page.items);
      next.set(page.next_cursor ?? null);
    } catch (error) {
      if (!controller.signal.aborted) problem.set(messageFor(error));
    } finally {
      if (!controller.signal.aborted) loading.set(false);
    }
  }

  void fetchPage();
  return {
    items,
    next,
    loading,
    problem,
    reload: () => fetchPage(),
    more: () => fetchPage(true),
  };
}
