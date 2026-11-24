import { isAvailable as desktopAvailable } from "nsh/desktop";
import { platform, View } from "nsh";
import { t } from "nsh/i18n";
import type { SystemNotifications } from "../inbox";
import type { Preferences } from "../preferences";
import { Action, Choice, Hint, Panel, Problem, Toggle } from "./Controls";
import type { SpeechPlayback } from "./Speech";

export function PreferenceControls(props: { preferences: Preferences }) {
  const current = props.preferences;
  return (
    <Panel>
      <Choice
        label={t("preferences.language")}
        value={current.settings().language}
        items={[
          { value: "system", title: t("preferences.follow_system") },
          { value: "zh-CN", title: t("preferences.simplified_chinese") },
          { value: "en", title: t("preferences.english") },
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
          ...(current.omarchyAvailable
            ? [{ value: "omarchy", title: t("preferences.omarchy") }]
            : []),
        ]}
        onChange={current.changeAppearance}
      />
      <If when={desktopAvailable && platform.os !== "web"}>
        <Choice
          label={t("preferences.close_behavior")}
          value={current.settings().closeBehavior ?? "quit"}
          items={[
            { value: "quit", title: t("preferences.quit") },
            { value: "tray", title: t("preferences.minimize_to_tray") },
          ]}
          onChange={current.changeCloseBehavior}
        />
      </If>
      <If when={!current.saved()}>
        <Hint>{t("preferences.session_only")}</Hint>
      </If>
    </Panel>
  );
}

export function NotificationControls(props: {
  notifications: SystemNotifications;
  speech: SpeechPlayback;
}) {
  const system = props.notifications;
  return (
    <Panel>
      <View class="gap-1">
        <Toggle
          label={t("inbox.show_system_notifications_for_this_session")}
          checked={system.enabled()}
          onChange={system.changeNative}
          disabled={system.checkingPermission()}
        />
        <Toggle
          label={t("speech.autoplay")}
          checked={props.speech.auto()}
          onChange={props.speech.changeAuto}
        />
      </View>
      <Hint>{t("inbox.messages_arrive_while_the_app_is")}</Hint>
      <If when={system.enabled()}>
        <Action
          label={t("inbox.test_system_notification")}
          class="self-start"
          disabled={system.testingNative() || system.checkingPermission()}
          onPress={() => void system.testNative()}
        />
      </If>
      <If when={system.testAccepted()}>
        <Hint>{t("inbox.system_notification_test_accepted")}</Hint>
      </If>
      <Problem message={system.nativeMessage()} />
    </Panel>
  );
}
