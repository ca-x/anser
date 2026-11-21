import { t } from "nsh/i18n";
import type { Preferences } from "../preferences";
import { Choice, Hint, Panel } from "./Controls";

export function PreferenceControls(props: { preferences: Preferences }) {
  const current = props.preferences;
  return (
    <Panel>
      <Choice
        label={t("preferences.language")}
        value={current.settings().language}
        items={[
          { value: "system", title: t("preferences.follow_system") },
          { value: "zh-CN", title: "简体中文" },
          { value: "en", title: "English" },
        ]}
        onChange={current.changeLanguage}
      />
      <Choice
        label={t("preferences.appearance")}
        value={current.settings().appearance}
        items={[
          { value: "system", title: t("preferences.follow_system") },
          { value: "light", title: t("preferences.light") },
          { value: "dark", title: t("preferences.dark") },
        ]}
        onChange={current.changeAppearance}
      />
      <If when={!current.saved()}>
        <Hint>{t("preferences.session_only")}</Hint>
      </If>
    </Panel>
  );
}
