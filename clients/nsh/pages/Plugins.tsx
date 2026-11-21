import { resource, signal, Text, View } from "nsh";
import { t } from "nsh/i18n";
import { messageFor, type AnserApi } from "../api";
import { channelName } from "../channelNames";
import {
  Action,
  confirm,
  Hint,
  Panel,
  Problem,
  ReadState,
  Section,
} from "../components/Controls";
import { RecordRow, WorkspacePage } from "../components/Workspace";
import type { Account, Channel, ChannelRuntime } from "../contracts";
import { operation } from "../state";
import { AccountList } from "./Accounts";

function PluginStatus(props: { channel: ChannelRuntime }) {
  const status = () => {
    if (props.channel.enabled === false) return "disabled";
    if (props.channel.available === false) return "unavailable";
    return props.channel.available || props.channel.enabled
      ? "enabled"
      : "unknown_status";
  };
  return (
    <Text
      class={
        status() === "enabled"
          ? "text-sm text-success"
          : "text-sm text-muted-foreground"
      }
    >
      {t(`plugins.${status()}`)}
    </Text>
  );
}

export function Plugins(props: {
  api: AnserApi;
  channels: Channel[];
  onBack: () => void;
  onOpen: (channel: Channel) => void;
  onRefresh: (channels: Channel[]) => void;
}) {
  const refresh = operation();
  return (
    <WorkspacePage title={t("plugins.title")} back={props.onBack}>
      <Action
        label={t("common.refresh")}
        kind="quiet"
        class="self-start"
        disabled={refresh.busy()}
        onPress={() =>
          void refresh.run(async () => {
            const channels = await props.api.channels();
            if (refresh.live()) props.onRefresh(channels);
          })
        }
      />
      <ReadState
        loading={refresh.busy()}
        problem={refresh.problem()}
        empty={!props.channels.length}
        emptyLabel={t("plugins.empty")}
      />
      <Each of={props.channels} key={(channel) => channel.id}>
        {(channel) => (
          <RecordRow
            title={channelName(channel().id, channel().display_name)}
            status={<PluginStatus channel={channel()} />}
            action={{
              label: t("plugins.configure"),
              accessibilityLabel: t("plugins.configure_plugin", {
                name: channelName(channel().id, channel().display_name),
              }),
            }}
            onPress={() => props.onOpen(channel())}
          />
        )}
      </Each>
    </WorkspacePage>
  );
}

export function PluginSettings(props: {
  api: AnserApi;
  channel: Channel;
  admin: boolean;
  revision: number;
  onBack: () => void;
  onOpenAccount: (account: Account) => void;
  onCreateAccount: () => void;
  onChange: (channel: Channel) => void;
}) {
  const current = resource(({ signal: abort }) =>
    props.api.channel(props.channel.id, abort),
  );
  const action = operation();
  const updated = signal<ChannelRuntime | undefined>(undefined);
  const reloaded = signal(false);
  const channel = () => ({ ...(current() ?? props.channel), ...updated() });
  const description = () => channelName(channel().id, channel().display_name);
  const loadBusy = () =>
    current.state() === "pending" || current.state() === "refreshing";
  const canManage = () =>
    (channel().can_manage ?? props.admin) && channel().enabled != null;
  const formats = () => channel().capabilities.formats ?? [];

  function change(request: { enabled: boolean } | { reload: true }) {
    void action.run(async () => {
      if (!canManage()) return;
      if (
        "enabled" in request &&
        !request.enabled &&
        !(await confirm(
          t("plugins.confirm_disable", { name: description() }),
          t("plugins.disable_hint"),
          t("plugins.disable"),
        ))
      )
        return;
      reloaded.set(false);
      const response = await props.api.changeChannel(channel().id, request);
      if (!action.live()) return;
      updated.set(response);
      props.onChange(channel());
      reloaded.set("reload" in request);
    });
  }

  return (
    <WorkspacePage title={description()} back={props.onBack}>
      <Section title={t("plugins.runtime")}>
        <Panel>
          <PluginStatus channel={channel()} />
          <Problem
            message={
              action.problem() ||
              (current.error() ? messageFor(current.error()) : "")
            }
          />
          <If when={loadBusy()}>
            <Hint>{t("controls.loading")}</Hint>
          </If>
          <If
            when={canManage()}
            else={
              <If
                when={
                  !loadBusy() &&
                  !current.error() &&
                  (channel().can_manage ?? props.admin)
                }
              >
                <Hint>{t("plugins.feature_unavailable")}</Hint>
              </If>
            }
          >
            <View class="flex-row flex-wrap gap-2">
              <Action
                label={
                  channel().enabled ? t("plugins.disable") : t("plugins.enable")
                }
                onPress={() => change({ enabled: !channel().enabled })}
                disabled={loadBusy() || action.busy()}
              />
              <If when={channel().enabled}>
                <Action
                  label={t("plugins.reload")}
                  kind="quiet"
                  onPress={() => change({ reload: true })}
                  disabled={loadBusy() || action.busy()}
                />
              </If>
            </View>
          </If>
          <If when={reloaded()}>
            <Hint>{t("plugins.reloaded")}</Hint>
          </If>
          <If when={formats().length > 0}>
            <Hint>
              {t("plugins.formats", {
                formats: formats()
                  .map((format) =>
                    format === "text"
                      ? t("common.plain_text")
                      : format === "markdown"
                        ? "Markdown"
                        : "HTML",
                  )
                  .join(" · "),
              })}
            </Hint>
          </If>
        </Panel>
      </Section>
      <Section title={t("plugins.accounts")}>
        <AccountList
          api={props.api}
          channel={channel()}
          channels={[]}
          revision={props.revision}
          onOpen={props.onOpenAccount}
          onCreate={props.onCreateAccount}
        />
      </Section>
    </WorkspacePage>
  );
}
