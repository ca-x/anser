import { batch, cleanup, setColorScheme, signal, Storage } from "nsh";
import { setLocale } from "nsh/i18n";

const storageKey = "anser.preferences";

type Language = "system" | "en" | "zh-CN";
type Appearance = "system" | "light" | "dark";
type Settings = { language: Language; appearance: Appearance };

function parseSettings(raw: string | null): Settings | undefined {
  if (!raw) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return undefined;
    const { language, appearance } = value as Partial<Settings>;
    return {
      language: language === "en" || language === "zh-CN" ? language : "system",
      appearance:
        appearance === "light" || appearance === "dark" ? appearance : "system",
    };
  } catch {
    return undefined;
  }
}

export function createPreferences() {
  const settings = signal<Settings>({
    language: "system",
    appearance: "system",
  });
  const ready = signal(false);
  const saved = signal(true);
  let live = true;
  let revision = 0;
  cleanup(() => {
    live = false;
  });

  function apply(next: Settings) {
    batch(() => {
      settings.set(next);
      setLocale(next.language === "system" ? null : next.language);
      setColorScheme(next.appearance);
    });
  }

  void Storage.getItem(storageKey)
    .then((raw) => {
      const initial = parseSettings(raw);
      if (initial && live && revision === 0) apply(initial);
    })
    .catch(() => undefined)
    .finally(() => {
      if (live) ready.set(true);
    });

  function update(next: Settings) {
    const target = ++revision;
    apply(next);
    void Storage.setItem(storageKey, JSON.stringify(next)).then(
      () => {
        if (live && revision === target) saved.set(true);
      },
      () => {
        if (live && revision === target) saved.set(false);
      },
    );
  }

  return {
    settings,
    ready,
    saved,
    changeLanguage(language: string | null) {
      update({
        ...settings(),
        language:
          language === "en" || language === "zh-CN" ? language : "system",
      });
    },
    changeAppearance(appearance: string | null) {
      update({
        ...settings(),
        appearance:
          appearance === "light" || appearance === "dark"
            ? appearance
            : "system",
      });
    },
  };
}

export type Preferences = ReturnType<typeof createPreferences>;
