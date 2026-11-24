import {
  batch,
  cleanup,
  platform,
  setColorScheme,
  setTheme,
  signal,
  Storage,
} from "nsh";
import { setLocale } from "nsh/i18n";
import { SystemTheme } from "anser-native";

const storageKey = "anser.preferences";

type Language = "system" | "en" | "zh-CN";
type Appearance = "system" | "light" | "dark" | "omarchy";
type Settings = {
  language: Language;
  appearance: Appearance;
  sidebarCollapsed?: boolean;
  closeBehavior?: "tray";
  systemNotifications?: boolean;
  speechAutoplay?: false;
};

function resolveAppearance(value: unknown, omarchyAvailable: boolean): Appearance {
  if (value === "light" || value === "dark") return value;
  if (value === "omarchy" && omarchyAvailable) return value;
  return "system";
}

function parseSettings(raw: string | null, omarchyAvailable: boolean): Settings | undefined {
  if (!raw) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return undefined;
    const { language, appearance, sidebarCollapsed, closeBehavior, systemNotifications, speechAutoplay } = value as Partial<Settings>;
    return {
      language: language === "en" || language === "zh-CN" ? language : "system",
      appearance: resolveAppearance(appearance, omarchyAvailable),
      ...(sidebarCollapsed === true ? { sidebarCollapsed: true } : {}),
      ...(closeBehavior === "tray" ? { closeBehavior } : {}),
      ...(systemNotifications === true ? { systemNotifications } : {}),
      ...(speechAutoplay === false ? { speechAutoplay } : {}),
    };
  } catch {
    return undefined;
  }
}

export function createPreferences() {
  const omarchyAvailable = platform.os === "linux" && SystemTheme.omarchyAvailable();
  const settings = signal<Settings>({
    language: "system",
    appearance: "system",
  });
  const ready = signal(false);
  const saved = signal(true);
  let live = true;
  let pending = Promise.resolve();
  let revision = 0;
  let appliedAppearance: Appearance | undefined;
  cleanup(() => {
    live = false;
    if (appliedAppearance === "omarchy") SystemTheme.stopFollowingOmarchy();
  });

  function apply(next: Settings) {
    batch(() => {
      settings.set(next);
      setLocale(next.language === "system" ? null : next.language);
      if (next.appearance === appliedAppearance) return;

      if (appliedAppearance === "omarchy") {
        SystemTheme.stopFollowingOmarchy();
        setTheme(null);
      }
      appliedAppearance = next.appearance;
      if (next.appearance === "omarchy") SystemTheme.followOmarchy();
      else setColorScheme(next.appearance);
    });
  }

  void Storage.getItem(storageKey)
    .then((raw) => {
      const initial = parseSettings(raw, omarchyAvailable);
      if (initial && live && revision === 0) apply(initial);
    })
    .catch(() => undefined)
    .finally(() => {
      if (!live) return;
      if (appliedAppearance === undefined) apply(settings());
      ready.set(true);
    });

  function update(next: Settings) {
    const target = ++revision;
    apply(next);
    pending = Storage.setItem(storageKey, JSON.stringify(next)).then(
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
    omarchyAvailable,
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
        appearance: resolveAppearance(appearance, omarchyAvailable),
      });
    },
    toggleSidebar() {
      const { sidebarCollapsed, ...rest } = settings();
      update(sidebarCollapsed ? rest : { ...rest, sidebarCollapsed: true });
    },
    changeCloseBehavior(value: string | null) {
      update({ ...settings(), closeBehavior: value === "tray" ? "tray" : undefined });
    },
    changeSystemNotifications(enabled: boolean) {
      update({ ...settings(), systemNotifications: enabled || undefined });
    },
    changeSpeechAutoplay(enabled: boolean) {
      update({ ...settings(), speechAutoplay: enabled ? undefined : false });
    },
    flush: () => pending,
  };
}

export type Preferences = ReturnType<typeof createPreferences>;
