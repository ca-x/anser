import { cleanup, signal, Storage } from "nsh";
import { t } from "nsh/i18n";
import { ApiError, validateOrigin } from "./api";

const storageKey = "anser.servers";
const nameLimit = 64;

export type ServerProfile = { origin: string; name: string };
type Settings = { profiles: ServerProfile[]; defaults: string[]; last?: string };

export function serverLabel(origin: string, name = "") {
  return name || new URL(origin).host;
}

function readSettings(raw: string | null): Settings {
  const profiles = new Map<string, ServerProfile>();
  const empty = { profiles: [], defaults: [] };
  if (!raw) return empty;
  try {
    const { profiles: entries, defaults, last } = JSON.parse(raw) ?? {};
    if (!Array.isArray(entries)) return empty;
    for (const entry of entries) {
      if (typeof entry?.origin !== "string")
        continue;
      try {
        const origin = validateOrigin(entry.origin);
        profiles.set(origin, { origin, name: typeof entry.name === "string" ? entry.name.trim().slice(0, nameLimit) : "" });
      } catch {
        // Keep the valid profiles if an older entry can no longer be used.
      }
    }
    return {
      profiles: [...profiles.values()],
      last: typeof last === "string" && profiles.has(last) ? last : undefined,
      defaults: Array.isArray(defaults)
        ? [...new Set(defaults.filter((origin): origin is string =>
            typeof origin === "string" && profiles.has(origin),
          ))]
        : [],
    };
  } catch {
    return empty;
  }
}

export function createServers() {
  const items = signal<ServerProfile[]>([]);
  const defaults = signal<string[]>([]);
  const last = signal<string | undefined>(undefined);
  const ready = signal(false);
  const saved = signal(true);
  let pending = Promise.resolve();
  let live = true;
  cleanup(() => { live = false; });
  void Storage.getItem(storageKey)
    .then((raw) => {
      if (!live) return;
      const stored = readSettings(raw);
      items.set(stored.profiles);
      defaults.set(stored.defaults);
      last.set(stored.last);
    })
    .catch(() => { if (live) saved.set(false); })
    .finally(() => { if (live) ready.set(true); });

  function persist(next: ServerProfile[], destinations = defaults(), selected: string | null | undefined = last()) {
    items.set(next);
    defaults.set(destinations);
    last.set(selected ?? undefined);
    const write = Storage.setItem(storageKey, JSON.stringify({ profiles: next, defaults: destinations, last: selected ?? undefined }));
    pending = write.then(() => {
      if (live) saved.set(true);
    }, () => {
      if (live) saved.set(false);
    });
  }

  function save(origin: string, name: string, previous?: string) {
    const normalized = validateOrigin(origin);
    const trimmed = name.trim();
    if (trimmed.length > nameLimit || /[\u0000-\u001f\u007f]/u.test(trimmed))
      throw new ApiError("server_name_length", t("servers.name_limit"));
    if (normalized !== previous && items().some((item) => item.origin === normalized))
      throw new ApiError("server_already_saved", t("servers.already_saved"));
    const profile = { origin: normalized, name: trimmed };
    const existing = items();
    persist(
      previous
        ? existing.map((item) => item.origin === previous ? profile : item)
        : [...existing, profile],
      defaults().map((item) => item === previous ? normalized : item),
      previous !== undefined && last() === previous ? normalized : last(),
    );
    return profile;
  }

  return {
    items,
    defaults,
    ready,
    saved,
    save,
    label(origin: string) {
      return serverLabel(origin, items().find((item) => item.origin === origin)?.name);
    },
    last,
    flush: () => pending,
    remember(origin: string, activate: boolean) {
      const existing = items();
      const selected = activate ? origin : last();
      const next = existing.some((item) => item.origin === origin)
        ? existing : [...existing, { origin, name: "" }];
      if (next !== existing || selected !== last()) persist(next, defaults(), selected);
    },
    remove(origin: string) {
      persist(items().filter((item) => item.origin !== origin), defaults().filter((item) => item !== origin), last() === origin ? null : last());
    },
    toggleDefault(origin: string) {
      persist(items(), toggleOrigin(defaults(), origin));
    },
  };
}

export type Servers = ReturnType<typeof createServers>;

export function toggleOrigin(current: string[], origin: string) {
  return current.includes(origin)
    ? current.filter((item) => item !== origin)
    : [...current, origin];
}
