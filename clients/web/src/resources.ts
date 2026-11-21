import { useCallback, useEffect, useRef, useState } from "react";
import { Api, errorMessage, segment, type Page } from "./api";

export function useResource<T>(api: Api, path: string | undefined) {
  const [result, setResult] = useState<{ path?: string; data?: T; error?: string }>({});
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((value) => value + 1), []);
  useEffect(() => {
    if (path === undefined) return;
    const controller = new AbortController();
    setResult((current) => current.path === path ? { ...current, error: undefined } : { path });
    void api.read<T>(path, controller.signal).then(
      (data) => { if (!controller.signal.aborted) setResult({ path, data }); },
      (error: unknown) => { if (!controller.signal.aborted) setResult((current) => ({ ...current, path, error: errorMessage(error) })); },
    );
    return () => controller.abort();
  }, [api, path, version]);
  return { ...result, loading: result.data === undefined && result.error === undefined, reload };
}

export function usePage<T>(api: Api, path: string | undefined) {
  const result = useResource<Page<T>>(api, path);
  const [extra, setExtra] = useState<{ base: Page<T>; items: T[]; next?: string | null }>();
  const [busy, setBusy] = useState(false);
  const [extraError, setExtraError] = useState<{ base: Page<T>; message: string }>();
  const current = extra?.base === result.data ? extra : undefined;
  const next = current ? current.next : result.data?.next_cursor;
  const items = [...(result.data?.items ?? []), ...(current?.items ?? [])];
  return {
    items, next, loading: result.loading, busy,
    error: result.error ?? (extraError && extraError.base === result.data ? extraError.message : undefined),
    reload: result.reload,
    loadMore: async () => {
      const base = result.data;
      if (!path || !next || !base || busy) return;
      setBusy(true);
      setExtraError(undefined);
      try {
        const separator = path.includes("?") ? "&" : "?";
        const page = await api.read<Page<T>>(`${path}${separator}cursor=${segment(next)}`);
        setExtra({ base, items: [...(current?.items ?? []), ...page.items], next: page.next_cursor });
      } catch (error) {
        setExtraError({ base, message: errorMessage(error) });
      } finally {
        setBusy(false);
      }
    },
  };
}

export function useMutation() {
  const active = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return { busy, error, clear: () => setError(undefined), run: async (action: () => Promise<void>) => {
    if (active.current) return;
    active.current = true;
    setError(undefined);
    setBusy(true);
    try {
      await action();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      active.current = false;
      setBusy(false);
    }
  } };
}
