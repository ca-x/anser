import {
  appInfo,
  createMotion,
  Image,
  reduceMotion,
  resource,
  Text,
  View,
} from "nsh";
import { t } from "nsh/i18n";
import type { AnserApi } from "../api";
import logo from "../assets/logo.png";
import { Panel } from "../components/Controls";
import { WorkspacePage } from "../components/Workspace";

export function About(props: { api: AnserApi; onBack: () => void }) {
  return (
    <WorkspacePage title={t("about.title")} back={props.onBack}>
      <AboutContent api={props.api} />
    </WorkspacePage>
  );
}

export function AboutContent(props: { api?: AnserApi }) {
  const server = resource(
    () => props.api,
    (api, { signal }) => api.info(signal),
  );
  const motion = createMotion({
    enter: reduceMotion()
      ? undefined
      : {
          keyframes: {
            opacity: [0.65, 1],
            translateY: [5, 0],
            scale: [0.95, 1],
          },
          duration: 260,
          easing: [0.23, 1, 0.32, 1],
        },
  });
  const clientVersion = appInfo().version;

  return (
    <View class="w-full max-w-md gap-5 self-center">
      <View class="items-center gap-4 py-4">
        <Image
          src={logo}
          fadeDuration={0}
          accessibilityElementsHidden
          class="size-28"
          style={motion.style}
        />
        <Text class="text-2xl font-semibold text-foreground">
          {t("workspace.anser")}
        </Text>
      </View>
      <Panel>
        <Version
          label={t("about.app_version")}
          value={clientVersion ?? t("about.unavailable")}
        />
        <If when={props.api}>
          <View class="border-t border-border pt-3">
            <Version
              label={t("about.server_version")}
              value={
                server()?.version ||
                t(server.loading() ? "controls.loading" : "about.unavailable")
              }
            />
          </View>
        </If>
      </Panel>
    </View>
  );
}

function Version(props: { label: string; value: string }) {
  return (
    <View class="flex-row flex-wrap items-center justify-between gap-x-4 gap-y-1">
      <Text class="text-sm font-semibold text-foreground">{props.label}</Text>
      <Text class="text-sm text-muted-foreground">{props.value}</Text>
    </View>
  );
}
