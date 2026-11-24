import { useId, useState } from "react";
import { EuiBasicTable, EuiBadge, EuiButton, EuiButtonEmpty, EuiFieldNumber, EuiFieldText, EuiFormRow, EuiSelect } from "@elastic/eui";
import { Api, segment, type InstalledPlugin, type JsonObject, type Page, type Topic } from "../api";
import { ChannelFields } from "../components/ChannelFields";
import { Confirm, Drawer, Empty, Failure, JsonInput, More, object, Progress, useDate } from "../components/Common";
import { configDefaults, pluginLabel, serializeConfig } from "../form-values";
import { useLanguage, useT } from "../preferences";
import { useMutation, usePage, useResource } from "../resources";
import { PluginsWorkspace } from "./Channels";

type Schedule = {
  id: string; name: string; plugin_id: string; topic: string | null; interval_minutes: number;
  enabled: boolean; next_at: number; last_at: number | null; last_status: string | null; last_count: number;
};

export default function Schedules({ api, navigate }: { api: Api; navigate: (path: string) => void }) {
  const t = useT();
  const date = useDate();
  const preset = new URLSearchParams(location.search).get("plugin") ?? "";
  const [creating, setCreating] = useState(Boolean(preset));
  const [removing, setRemoving] = useState<Schedule>();
  const task = useMutation();
  const list = usePage<Schedule>(api, "/schedules");
  const language = useLanguage();
  const catalog = useResource<Page<InstalledPlugin>>(api, "/plugins");
  const plugins = (catalog.data?.items ?? []).filter((plugin) => plugin.kind === "task");
  const pluginName = (id: string) => {
    const plugin = plugins.find((entry) => entry.id === id);
    return plugin ? pluginLabel(plugin, language) ?? plugin.display_name : id;
  };
  const update = (item: Schedule, mode: "run" | "toggle" | "delete") => task.run(async () => {
    const path = `/schedules/${segment(item.id)}`;
    if (mode === "run") await api.write(`${path}/run`, "POST");
    else if (mode === "toggle") await api.write(path, "PUT", { enabled: !item.enabled });
    else { await api.write(path, "DELETE"); setRemoving(undefined); }
    list.reload();
  });
  return <PluginsWorkspace tab="schedules" navigate={navigate}>
    <div className="section-header">
      <div className="stack"><h2>{t("任务计划")}</h2><p className="muted">{t("按间隔运行任务插件，把生成的通知发送到指定主题或默认路由。")}</p></div>
      <div className="row-actions">
        <EuiButtonEmpty size="s" iconType="refresh" onClick={list.reload}>{t("刷新")}</EuiButtonEmpty>
        <EuiButton size="s" fill iconType="plusCircle" onClick={() => setCreating(true)}>{t("创建定时推送")}</EuiButton>
      </div>
    </div>
    <Failure message={list.error ?? catalog.error} retry={() => { list.reload(); catalog.reload(); }} />
    {!removing && <Failure message={task.error} />}
    {list.loading ? <Progress /> : list.items.length ? <div className="data-surface">
      <EuiBasicTable<Schedule> tableCaption={t("任务计划")} rowHeader="name" itemId="id" items={list.items} columns={[
        { field: "name", name: t("名称"), render: (_, item) => <div><strong>{item.name}</strong><p className="muted">{pluginName(item.plugin_id)}</p></div> },
        { field: "topic", name: t("发送到"), render: (topic: string | null) => topic || t("默认路由") },
        { field: "next_at", name: t("下次执行"), render: (_, item) => item.enabled ? date(item.next_at) : <EuiBadge>{t("已暂停")}</EuiBadge> },
        { field: "last_status", name: t("最近执行"), render: (_, item) => !item.last_at ? "—" : <div>
          {item.last_status === "success" ? t("已入队 {count} 条", { count: String(item.last_count) }) : t(item.last_status === "paused" ? "已暂停" : "执行失败")}
          <p className="muted">{date(item.last_at)}{item.last_status !== "success" && item.last_status !== "paused" && item.last_status ? ` · ${item.last_status}` : ""}</p></div> },
        { name: t("操作"), render: (item: Schedule) => <div className="row-actions">
          <EuiButtonEmpty size="xs" disabled={task.busy || !item.enabled} onClick={() => void update(item, "run")}>{t("立即执行")}</EuiButtonEmpty>
          <EuiButtonEmpty size="xs" disabled={task.busy} onClick={() => void update(item, "toggle")}>{t(item.enabled ? "暂停" : "恢复")}</EuiButtonEmpty>
          <EuiButtonEmpty size="xs" color="danger" disabled={task.busy} onClick={() => { task.clear(); setRemoving(item); }}>{t("删除")}</EuiButtonEmpty>
        </div> },
      ]} />
      <More next={list.next} busy={list.busy} load={() => void list.loadMore()} />
    </div> : !list.error && <Empty title={t("还没有定时推送")} />}
    {creating && <ScheduleEditor api={api} plugins={plugins} preset={preset} nameOf={pluginName} close={() => setCreating(false)}
      done={() => { setCreating(false); list.reload(); }} />}
    {removing && <Confirm title={t("删除「{name}」？", { name: removing.name })} label={t("删除")} busy={task.busy}
      close={() => setRemoving(undefined)} confirm={() => void update(removing, "delete")}>
      <Failure message={task.error} />
    </Confirm>}
  </PluginsWorkspace>;
}

function ScheduleEditor({ api, plugins, preset, nameOf, close, done }: {
  api: Api; plugins: InstalledPlugin[]; preset: string; nameOf: (id: string) => string; close: () => void; done: () => void;
}) {
  const t = useT();
  const id = useId();
  const [name, setName] = useState("");
  const [pluginId, setPluginId] = useState(preset);
  const [config, setConfig] = useState<JsonObject>();
  const [source, setSource] = useState("");
  const [start, setStart] = useState("");
  const [interval, setInterval] = useState("60");
  const [topic, setTopic] = useState("");
  const topics = usePage<Topic>(api, "/topics");
  const task = useMutation();
  const plugin = plugins.find(({ id }) => id === pluginId);
  const fields = config ?? (plugin ? configDefaults(plugin.config_schema) : {});
  const taskInput = plugin && (plugin.config_schema["x-anser-ui"] as { task_input?: string } | undefined)?.task_input !== "none";

  return <Drawer title={t("创建定时推送")} close={close}
    footer={<EuiButton type="submit" form={id} fill isLoading={task.busy} disabled={!plugin}>{t("保存计划")}</EuiButton>}>
    <form id={id} className="stack" onSubmit={(event) => { event.preventDefault(); if (!plugin) return;
      void task.run(async () => {
        const startAt = start ? new Date(start).getTime() : undefined;
        if (startAt !== undefined && !Number.isFinite(startAt)) throw new Error(t("请输入有效的开始时间。"));
        await api.write("/schedules", "POST", { name: name.trim(), plugin_id: pluginId, interval_minutes: Number(interval),
          topic: topic || null, start_at: startAt, config: serializeConfig(plugin, fields), input: taskInput ? object(source || "{}") : null });
        done();
      });
    }}>
      <Failure message={task.error} />
      <EuiFormRow label={t("名称")} fullWidth><EuiFieldText fullWidth required value={name} onChange={(event) => setName(event.target.value)} /></EuiFormRow>
      <EuiFormRow label={t("任务插件")} fullWidth><EuiSelect fullWidth required value={pluginId}
        onChange={(event) => { setPluginId(event.target.value); setConfig(undefined); setSource(""); }}
        options={[{ value: "", text: t("请选择") }, ...plugins.map(({ id }) => ({ value: id, text: nameOf(id) }))]} /></EuiFormRow>
      {plugin && <ChannelFields key={plugin.id} channel={plugin} value={fields} update={setConfig} />}
      {taskInput && <JsonInput label={t("任务输入")} value={source} set={setSource} />}
      <EuiFormRow label={t("发送到")} fullWidth><EuiSelect fullWidth value={topic} onChange={(event) => setTopic(event.target.value)}
        options={[{ value: "", text: t("默认路由") }, ...topics.items.filter(({ enabled }) => enabled).map(({ name }) => ({ value: name, text: name }))]} /></EuiFormRow>
      <Failure message={topics.error} retry={topics.reload} />
      <More next={topics.next} busy={topics.busy} load={() => void topics.loadMore()} />
      <EuiFormRow label={t("执行间隔（分钟）")} fullWidth><EuiFieldNumber fullWidth required min={1} max={43200} step={1}
        value={interval} onChange={(event) => setInterval(event.target.value)} /></EuiFormRow>
      <EuiFormRow label={t("首次执行时间")} helpText={t("使用当前时区。留空则在一个执行间隔后运行。")} fullWidth>
        <EuiFieldText fullWidth type="datetime-local" value={start} onChange={(event) => setStart(event.target.value)} />
      </EuiFormRow>
    </form>
  </Drawer>;
}
