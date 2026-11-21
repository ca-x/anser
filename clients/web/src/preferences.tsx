import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { EuiButtonIcon, EuiContext, EuiFormRow, EuiPopover, EuiProvider, EuiSelect } from "@elastic/eui";
import { channelDisplayName, chooseLanguage, chooseTheme, resolveTheme, translate, type Language, type ThemePreference } from "./locale";
import { consoleTheme } from "./theme";

const languageKey = "anser.ui.language";
const themeKey = "anser.ui.theme";
const colorQuery = "(prefers-color-scheme: dark)";

function readPreference(key: string) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function storePreference(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* Private storage can be unavailable. */ }
}

const PreferencesContext = createContext<{
  language: Language;
  theme: ThemePreference;
  setLanguage: (value: Language) => void;
  setTheme: (value: ThemePreference) => void;
}>({
  language: "zh-CN",
  theme: "system",
  setLanguage: () => undefined,
  setTheme: () => undefined,
});

const chineseEui = {
  mapping: {
    "euiFlyoutCloseButton.ariaLabel": "关闭",
    "euiModal.closeModal": "关闭",
    "euiPopover.screenReaderAnnouncement": "按 Esc 或点击面板外部可关闭。",
    "euiModal.screenReaderModalDialog": "按 Esc 或点击对话框外部可关闭。",
  },
};

export function Preferences({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState(() => chooseLanguage(readPreference(languageKey), navigator.language));
  const [theme, setTheme] = useState(() => chooseTheme(readPreference(themeKey)));
  const [systemDark, setSystemDark] = useState(() => matchMedia(colorQuery).matches);
  const color = resolveTheme(theme, systemDark);

  useEffect(() => {
    const query = matchMedia(colorQuery);
    const update = () => setSystemDark(query.matches);
    query.addEventListener("change", update);
    update();
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    document.documentElement.lang = language;
    document.title = translate(language, "雁字控制台");
  }, [language]);
  useEffect(() => { document.documentElement.dataset.theme = color; }, [color]);

  const value = useMemo(() => ({
    language, theme,
    setLanguage: (value: Language) => { storePreference(languageKey, value); setLanguage(value); },
    setTheme: (value: ThemePreference) => { storePreference(themeKey, value); setTheme(value); },
  }), [language, theme]);

  return <PreferencesContext.Provider value={value}>
    <EuiProvider colorMode={color} modify={consoleTheme}>
      <EuiContext i18n={{ ...(language === "zh-CN" ? chineseEui : {}), locale: language }}>{children}</EuiContext>
    </EuiProvider>
  </PreferencesContext.Provider>;
}

export function useLanguage() {
  return useContext(PreferencesContext).language;
}

export function useT() {
  const language = useLanguage();
  return (key: string, values?: Record<string, string | number>) => translate(language, key, values);
}

export function useChannelName() {
  const language = useLanguage();
  return (id: string, fallback?: string) => channelDisplayName(language, id, fallback);
}

export function PreferenceMenu() {
  const [open, setOpen] = useState(false);
  const { language, theme, setLanguage, setTheme } = useContext(PreferencesContext);
  const t = useT();
  const label = t("界面设置");
  return <EuiPopover
    button={<EuiButtonIcon iconType="gear" display="empty" size="m" className="preference-button" title={label}
      aria-label={label} aria-expanded={open} onClick={() => setOpen((value) => !value)} />}
    isOpen={open} closePopover={() => setOpen(false)} anchorPosition="downRight" ownFocus panelPaddingSize="m"
  >
    <div className="preference-panel stack">
      <EuiFormRow label={t("语言")} fullWidth>
        <EuiSelect fullWidth value={language} onChange={(event) => setLanguage(chooseLanguage(event.target.value, language))}
          options={[{ value: "zh-CN", text: t("简体中文") }, { value: "en", text: t("英文") }]} />
      </EuiFormRow>
      <EuiFormRow label={t("主题外观")} fullWidth>
        <EuiSelect fullWidth value={theme} onChange={(event) => setTheme(chooseTheme(event.target.value))}
          options={[
            { value: "system", text: t("跟随系统") },
            { value: "light", text: t("浅色") },
            { value: "dark", text: t("深色") },
          ]} />
      </EuiFormRow>
    </div>
  </EuiPopover>;
}
