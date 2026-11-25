import { cleanup, computed, effect, resource, signal, Text, View } from "nsh";
import { Tooltip } from "nsh/base";
import { t } from "nsh/i18n";
import { ApiError, messageFor, type AnserApi } from "../api";
import { channelName } from "../channelNames";
import {
  ChannelConfig, channelConfigDraft, dynamicOptionInputs, pluginHelp, pluginLabel, supportsTransformSettings, transformDraft,
} from "../components/ChannelConfig";
import {
  Action,
  confirm,
  Hint,
  Panel,
  Problem,
  ReadState,
  Section,
  Toggle,
} from "../components/Controls";
import { RecordRow, WorkspacePage } from "../components/Workspace";
import type { Account, Channel, ChannelRuntime, InstalledPlugin, PluginChoice, SavedTransformConfig } from "../contracts";
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

function DirectionIcon(props: Pick<Channel, "direction">) {
  const direction = () => props.direction ?? "egress";
  const label = () => t(`plugins.direction_${direction()}`);
  return <View accessibilityLabel={label()} tooltip={<Tooltip class="rounded-(--radius) bg-popover px-2 py-1">
    <Text class="text-sm text-popover-foreground">{label()}</Text>
  </Tooltip>}>
    <Text class="text-base text-muted-foreground">{({ ingress: "↧", egress: "↥", bidirectional: "⇅" })[direction()]}</Text>
  </View>;
}

function Help(props: { plugin: Channel | InstalledPlugin }) {
  return <If when={pluginHelp(props.plugin)}>
    {(help) => <Section title={t("plugins.help")}><Panel><View selectable>
      <Text class="text-sm text-foreground">{help()}</Text>
    </View></Panel></Section>}
  </If>;
}

const pluginKinds = ["channel", "task", "content_transform"] as const;

export function Plugins(props: {
  api: AnserApi;
  channels: Channel[];
  onBack: () => void;
  onOpen: (channel: Channel) => void;
  onRefresh: (channels: Channel[]) => void;
}) {
  const inventory = resource(async ({ signal: abort }) => {
    try {
      return await props.api.plugins(abort);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return [];
      throw error;
    }
  });
  const refresh = operation();
  const editing = signal<InstalledPlugin | undefined>(undefined);
  const pending = () => ["pending", "refreshing"].includes(inventory.state());
  const group = (kind: InstalledPlugin["kind"]) =>
    (inventory() ?? []).filter((plugin) => plugin.kind === kind);
  const label = (plugin: InstalledPlugin) =>
    pluginLabel(plugin) ?? (plugin.kind === "channel"
      ? channelName(plugin.id, plugin.display_name)
      : plugin.display_name);

  return <If when={editing()} else={
    <WorkspacePage title={t("plugins.title")} back={props.onBack}>
      <Action
        label={t("common.refresh")}
        kind="quiet"
        class="self-start"
        disabled={refresh.busy() || pending()}
        onPress={() =>
          void refresh.run(async () => {
            const [channels] = await Promise.all([
              props.api.channels(),
              inventory.refetch(),
            ]);
            if (refresh.live()) props.onRefresh(channels);
          })
        }
      />
      <ReadState
        loading={refresh.busy() || pending()}
        problem={refresh.problem() || (inventory.error() ? messageFor(inventory.error()) : "")}
        empty={!props.channels.length && !inventory()?.length}
        emptyLabel={t("plugins.empty")}
      />
      <If when={props.channels.length > 0}>
        <Section title={t("plugins.group_channel")}>
          <Each of={props.channels} key={(channel) => channel.id}>
            {(channel) => {
              const metadata = () => group("channel").find((entry) => entry.id === channel().id);
              const name = () => {
                const plugin = metadata();
                return plugin ? label(plugin) : channelName(channel().id, channel().display_name);
              };
              return (
                <RecordRow
                  title={name()}
                  subtitle={metadata()?.version}
                  status={<View class="flex-row items-center gap-2"><DirectionIcon direction={channel().direction} /><PluginStatus channel={channel()} /></View>}
                  action={{
                    label: t("plugins.configure"),
                    accessibilityLabel: t("plugins.configure_plugin", { name: name() }),
                  }}
                  onPress={() => props.onOpen(channel())}
                />
              );
            }}
          </Each>
        </Section>
      </If>
      <Each of={pluginKinds.filter((kind) => kind !== "channel" && group(kind).length > 0)} key={(kind) => kind}>
        {(kind) => (
          <Section title={t(`plugins.group_${kind()}`)}>
            <Each of={group(kind())} key={(plugin) => plugin.id}>
              {(plugin) => (
                <RecordRow
                  title={label(plugin())}
                  subtitle={plugin().version}
                  status={<PluginStatus channel={plugin()} />}
                  action={supportsTransformSettings(plugin()) ? {
                    label: t("plugins.configure"),
                    accessibilityLabel: t("plugins.configure_plugin", { name: label(plugin()) }),
                  } : pluginHelp(plugin()) ? { label: t("plugins.help"), accessibilityLabel: t("plugins.help_for", { name: label(plugin()) }) } : undefined}
                  onPress={supportsTransformSettings(plugin()) || pluginHelp(plugin()) ? () => editing.set(plugin()) : undefined}
                />
              )}
            </Each>
          </Section>
        )}
      </Each>
    </WorkspacePage>
  }>
    {(plugin) => supportsTransformSettings(plugin())
      ? <TransformSettings api={props.api} plugin={plugin()} back={() => editing.set(undefined)} />
      : <WorkspacePage title={label(plugin())} back={() => editing.set(undefined)}><Help plugin={plugin()} /></WorkspacePage>}
  </If>;
}

function TransformSettings(props: { api: AnserApi; plugin: InstalledPlugin; back: () => void }) {
  const plugin = props.plugin;
  const loading = operation();
  const saving = operation();
  const saved = signal<SavedTransformConfig | undefined>(undefined);
  const draft = channelConfigDraft(() => plugin, () => saved()?.saved_credentials ?? []);
  const notice = signal(false);
  const choices = signal<Record<string, { items?: PluginChoice[]; loading?: boolean; failed?: boolean }>>({});
  const optionRequest = computed(() => {
    const config = saved();
    return config ? JSON.stringify([config.revision, dynamicOptionInputs(plugin, draft.values(), config)]) : undefined;
  });

  function accept(config: SavedTransformConfig) {
    draft.values.set(transformDraft(plugin, config));
    saved.set(config);
  }
  function load() {
    void loading.run(async () => {
      const config = await props.api.transformSettings(plugin.id);
      if (loading.live()) accept(config);
    });
  }
  function save() {
    notice.set(false);
    void saving.run(async () => {
      const config = await props.api.saveTransformSettings(plugin.id, draft.value(), saved()?.revision ?? null);
      if (!saving.live()) return;
      accept(config);
      notice.set(true);
    });
  }
  effect(() => {
    const request = optionRequest();
    if (!request) return;
    const [revision, inputs] = JSON.parse(request) as [string | null, Record<string, Record<string, string>>];
    const entries = Object.entries(inputs);
    choices.set(Object.fromEntries(entries.map(([field]) => [field, { loading: true }])));
    const abort = new AbortController();
    const timer = setTimeout(() => {
      for (const [field, value] of entries) {
        const report = (result: { items?: PluginChoice[]; failed?: boolean }) => {
          if (!abort.signal.aborted) choices.update((previous) => ({ ...previous, [field]: result }));
        };
        void props.api.transformOptions(plugin.id, field, value, revision, abort.signal)
          .then(({ items }) => report({ items }), () => report({ failed: true }));
      }
    }, 350);
    cleanup(() => { clearTimeout(timer); abort.abort(); });
  });
  load();

  return <WorkspacePage title={pluginLabel(plugin) ?? plugin.display_name} back={props.back}
    footer={<Action label={saving.busy() ? t("common.saving") : t("plugins.save_settings")}
      kind="primary" disabled={!saved() || saving.busy()} onPress={save} />}>
    <Help plugin={plugin} />
    <Problem message={loading.problem() || saving.problem()} />
    <If when={loading.busy()}><Hint>{t("controls.loading")}</Hint></If>
    <If when={loading.problem()}><Action label={t("common.refresh")} onPress={load} /></If>
    <If when={notice()}><Hint>{t("plugins.settings_saved")}</Hint></If>
    <If when={saved()}><ChannelConfig draft={draft} guided choices={choices()} /></If>
  </WorkspacePage>;
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

  function change(request: Parameters<AnserApi["changeChannel"]>[1]) {
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
          <If when={channel().direction && channel().direction !== "egress" && channel().ingress_enabled !== undefined}>
            <Toggle label={t("plugins.allow_ingress")} checked={!!channel().ingress_enabled}
              disabled={!canManage() || !channel().enabled || action.busy()} onChange={(value) => change({ ingress_enabled: value })} />
          </If>
          <If when={channel().direction && channel().direction !== "ingress" && channel().egress_enabled !== undefined}>
            <Toggle label={t("plugins.allow_egress")} checked={!!channel().egress_enabled}
              disabled={!canManage() || !channel().enabled || action.busy()} onChange={(value) => change({ egress_enabled: value })} />
          </If>
          <If when={formats().length > 0 && channel().direction !== "ingress"}>
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
      <Help plugin={channel()} />
      <If when={!!channel().ingress_routes?.length}>
        <Section title={t("plugins.ingress_api")}>
          <Panel>
            <Hint>{t("plugins.ingress_auth")}</Hint>
            <View selectable>
              <Each of={channel().ingress_routes ?? []} key={(route) => `${route.method} ${route.path}`}>
                {(route) => <View class="gap-1">
                  <Text class="text-sm text-foreground">{`${route().method} ${props.api.origin}/v1/receive/${encodeURIComponent(channel().id)}${route().path}`}</Text>
                  <If when={route().example}>{(example) => <Text class="text-sm text-muted-foreground">{example()}</Text>}</If>
                </View>}
              </Each>
            </View>
          </Panel>
        </Section>
      </If>
      <If when={channel().direction !== "ingress"}>
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
      </If>
    </WorkspacePage>
  );
}
