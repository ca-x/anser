import { useState, type MouseEvent } from "react";
import { EuiBadge, EuiButton, EuiButtonEmpty, EuiLink, EuiTab, EuiTabs, EuiText } from "@elastic/eui";
import { Api, segment, type Channel, type ChannelRuntime, type InstalledPlugin, type Page } from "../api";
import { PluginRunner } from "../components/PluginRunner";
import { RowAction, Confirm, Empty, Failure, PageTitle, Progress } from "../components/Common";
import { pluginLabel } from "../form-values";
import { useChannelName, useLanguage, useT } from "../preferences";
import { useMutation, useResource } from "../resources";
import { AccountList } from "./Accounts";

type Navigate = (path: string) => void;
const listPath = "/admin/channels";
const runtimeEnabled = (channel: Pick<Channel, "enabled" | "available">) => channel.enabled ?? (channel.available !== false);

function follow(event: MouseEvent, path: string, navigate: Navigate) {
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate(path);
}

function PluginStatus({ channel }: { channel: Pick<Channel, "enabled" | "available"> }) {
  const t = useT();
  if (!runtimeEnabled(channel)) return <EuiBadge>{t("已停用")}</EuiBadge>;
  if (channel.available === false) return <EuiBadge color="warning">{t("暂不可用")}</EuiBadge>;
  return <EuiBadge color="success">{t("运行中")}</EuiBadge>;
}

const pluginGroups = [
  { kind: "channel", label: "渠道插件" },
  { kind: "task", label: "任务插件" },
  { kind: "content_transform", label: "内容转换插件" },
] as const;

export function PluginsWorkspace({ tab, navigate, children }: {
  tab: "built-in" | "market"; navigate: Navigate; children: React.ReactNode;
}) {
  const t = useT();
  const tabs = [
    ["built-in", listPath, "内置插件"],
    ["market", `${listPath}/market`, "插件市场"],
  ] as const;
  const panel = "plugin-workspace-panel";
  return <>
    <PageTitle title={t("插件管理")} />
    <EuiTabs aria-label={t("插件管理")}>
      {tabs.map(([id, path, title]) => <EuiTab key={id} id={`plugin-tab-${id}`} aria-controls={panel}
        isSelected={tab === id} onClick={() => navigate(path)}>{t(title)}</EuiTab>)}
    </EuiTabs>
    <div className="stack plugin-tab-content" id={panel} role="tabpanel" aria-labelledby={`plugin-tab-${tab}`}>{children}</div>
  </>;
}

export function Channels({ api, navigate }: { api: Api; navigate: Navigate }) {
  const t = useT();
  const language = useLanguage();
  const channelName = useChannelName();
  const list = useResource<Page<InstalledPlugin>>(api, "/plugins");
  const [active, setActive] = useState<InstalledPlugin>();
  const [filter, setFilter] = useState<InstalledPlugin["kind"]>();
  const items = list.data?.items ?? [];
  const name = (plugin: InstalledPlugin) => pluginLabel(plugin, language) ??
    (plugin.kind === "channel" ? channelName(plugin.id, plugin.display_name) : plugin.display_name);
  const typeLabel = (kind: InstalledPlugin["kind"]) => pluginGroups.find((group) => group.kind === kind)?.label ?? kind;

  return <PluginsWorkspace tab="built-in" navigate={navigate}>
    <div className="plugin-filters" role="group" aria-label={t("插件类型")}>
      {[{ kind: undefined, label: "全部插件" }, ...pluginGroups].map(({ kind, label }) =>
        <button key={label} type="button" aria-pressed={filter === kind} onClick={() => setFilter(kind)}>
          {t(label)} <span>{kind ? items.filter((item) => item.kind === kind).length : items.length}</span>
        </button>)}
    </div>
    <Failure message={list.error} retry={list.reload} />
    {list.loading && <Progress />}
    {list.data && !items.some((item) => !filter || item.kind === filter) && <Empty title={t("没有已安装的插件")} />}
    <ul className="plugin-grid">
      {items.filter((item) => !filter || item.kind === filter).map((plugin) => {
        const path = `${listPath}/${segment(plugin.id)}`;
        const settings = (plugin.config_schema["x-anser-ui"] as { persistent_settings?: boolean } | undefined)?.persistent_settings === true;
        return <li key={`${plugin.kind}:${plugin.id}`} className="plugin-tile">
          <div className="plugin-tile-meta"><EuiBadge>{t(typeLabel(plugin.kind))}</EuiBadge><PluginStatus channel={plugin} /></div>
          <h2>{plugin.kind === "channel" ? <EuiLink href={path} onClick={(event) => follow(event, path, navigate)}>{name(plugin)}</EuiLink> : name(plugin)}</h2>
          <div className="plugin-tile-actions">
            {plugin.version && <span className="muted">{plugin.version}</span>}
            {plugin.kind === "channel" ? <RowAction icon="gear" href={path} onClick={(event) => follow(event, path, navigate)}>{t("配置插件")}</RowAction>
              : <RowAction icon={settings ? "gear" : "play"} onClick={() => setActive(plugin)} disabled={!plugin.available}
                label={t(settings ? "配置 {name}" : "运行 {name}", { name: name(plugin) })}>
                {t(settings ? "配置插件" : "运行插件")}
              </RowAction>}
            {plugin.kind === "task" && <RowAction icon="clock" href={`/admin/schedules?plugin=${segment(plugin.id)}`}
              onClick={(event) => follow(event, `/admin/schedules?plugin=${segment(plugin.id)}`, navigate)}>{t("创建定时推送")}</RowAction>}
          </div>
        </li>;
      })}
    </ul>
    {active && <PluginRunner api={api} plugin={{ ...active, display_name: name(active) }} close={() => setActive(undefined)} />}
  </PluginsWorkspace>;
}

export function ChannelSettings({ api, id, navigate }: { api: Api; id: string; navigate: Navigate }) {
  const t = useT();
  const channelName = useChannelName();
  const path = `/channels/${segment(id)}`;
  const detail = useResource<Channel>(api, path);
  // Older channel detail responses omit runtime state, but the channel list includes availability.
  const legacy = detail.data && detail.data.enabled === undefined && detail.data.available === undefined;
  const catalog = useResource<Page<Channel>>(api, legacy ? "/channels" : undefined);
  const [result, setResult] = useState<ChannelRuntime>();
  const [confirmation, setConfirmation] = useState<"disable" | "reload">();
  const [notice, setNotice] = useState<string>();
  const action = useMutation();
  const fallback = legacy ? catalog.data?.items.find((entry) => entry.id === id) : undefined;
  const channel = detail.data && { ...detail.data, ...fallback, ...result };
  const name = channelName(id, channel?.display_name);
  const enabled = channel && runtimeEnabled(channel);
  const ready = channel && (!legacy || !!result || !!fallback);

  const update = (operation: "enable" | "disable" | "reload") => action.run(async () => {
    setNotice(undefined);
    const change = operation === "reload" ? { reload: true } : { enabled: operation === "enable" };
    try {
      const response = await api.write<ChannelRuntime>(`${path}/runtime`, "PUT", change);
      setResult({ ...response, enabled: response.enabled ?? change.enabled ?? enabled });
      setConfirmation(undefined);
      setNotice(operation === "reload" ? "插件已重载。" : operation === "enable" ? "插件已启用。" : "插件已停用。");
    } catch (error) {
      // An interrupted request can still change the server's stored setting.
      setResult(undefined);
      detail.reload();
      if (legacy) catalog.reload();
      throw error;
    }
  });

  return <>
    <EuiButtonEmpty className="channel-settings-back" href={listPath} size="s" flush="left" iconType="chevronSingleLeft"
      onClick={(event: MouseEvent<HTMLAnchorElement>) => follow(event, listPath, navigate)}>{t("插件管理")}</EuiButtonEmpty>
    <PageTitle title={name} />
    <Failure message={detail.error ?? (legacy ? catalog.error : undefined)} retry={detail.error ? detail.reload : catalog.reload} />
    {(detail.loading || (legacy && catalog.loading)) && <Progress />}
    {channel && ready && <>
      <section className="channel-settings" aria-label={t("运行设置")}>
        <div className="channel-settings-header">
          <h2>{t("运行设置")}</h2><PluginStatus channel={channel} />
        </div>
        {channel.available === false && <EuiText color="subdued" size="s"><p>{t("插件可用后，才能添加账号、替换凭据或测试发送。")}</p></EuiText>}
        {channel.can_manage !== false && <div className="channel-settings-actions">
          {enabled ? <>
            <EuiButton iconType="refresh" size="s" disabled={action.busy} onClick={() => { action.clear(); setConfirmation("reload"); }}>{t("重载插件")}</EuiButton>
            <EuiButton color="danger" size="s" disabled={action.busy} onClick={() => { action.clear(); setConfirmation("disable"); }}>{t("停用插件")}</EuiButton>
          </> : <EuiButton fill size="s" isLoading={action.busy} onClick={() => { void update("enable"); }}>{t("启用插件")}</EuiButton>}
        </div>}
        {!confirmation && <Failure message={action.error} />}
        <div role="status">{notice && <EuiText color="subdued" size="s"><p>{t(notice)}</p></EuiText>}</div>
      </section>
      <AccountList api={api} catalog={[channel]} channel={channel} />
    </>}
    {confirmation && <Confirm title={t(confirmation === "disable" ? "停用「{name}」？" : "重载「{name}」？", { name })}
      label={t(confirmation === "disable" ? "停用插件" : "重载插件")} busy={action.busy}
      close={() => { action.clear(); setConfirmation(undefined); }} confirm={() => { void update(confirmation); }}>
      <p>{t("正在执行的发送会先完成。已入队的投递保留在队列中。")}</p>
      <Failure message={action.error} />
    </Confirm>}
  </>;
}
