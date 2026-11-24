import { cleanup, signal, Storage } from "nsh";
import { t } from "nsh/i18n";
import { ApiError, validateOrigin } from "./api";

const storageKey = "anser.servers";
const nameLimit = 64;

export type ServerProfile = { origin: string; name: string };
type Settings = { profiles: ServerProfile[]; defaults: string[] };

export function serverLabel(origin: string, name = "") {
  return name || new URL(origin).host;
}

function readSettings(raw: string | null): Settings {
  const profiles = new Map<string, ServerProfile>();
  const empty = { profiles: [], defaults: [] };
  if (!raw) return empty;
  try {
    const { profiles: entries, defaults } = JSON.parse(raw) ?? {};
    if (!Array.isArray(entries)) return empty;
    for (const entry of entries) {
      if (typeof entry?.origin !== "string" || typeof entry?.name !== "string")
        continue;
      try {
        const origin = validateOrigin(entry.origin);
        profiles.set(origin, { origin, name: entry.name.trim().slice(0, nameLimit) });
      } catch {
        // Keep the valid profiles if an older entry can no longer be used.
      }
    }
    return {
      profiles: [...profiles.values()],
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
    })
    .catch(() => undefined)
    .finally(() => { if (live) ready.set(true); });

  function persist(next: ServerProfile[], destinations = defaults()) {
    items.set(next);
    defaults.set(destinations);
    pending = pending.then(async () => {
      try {
        await Storage.setItem(storageKey, JSON.stringify({ profiles: next, defaults: destinations }));
        if (live) saved.set(true);
      } catch {
        if (live) saved.set(false);
      }
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
    remember(origin: string) {
      const existing = items();
      if (existing.some((item) => item.origin === origin)) return;
      persist([...existing, { origin, name: "" }]);
    },
    remove(origin: string) {
      persist(items().filter((item) => item.origin !== origin), defaults().filter((item) => item !== origin));
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
