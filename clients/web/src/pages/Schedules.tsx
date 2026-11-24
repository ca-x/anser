import { useId, useState } from "react";
import { EuiBasicTable, EuiBadge, EuiButton, EuiButtonEmpty, EuiCheckboxGroup, EuiFieldNumber, EuiFieldText, EuiFlexGroup, EuiFlexItem, EuiFormRow, EuiSelect, EuiSwitch } from "@elastic/eui";
import { Api, segment, type InstalledPlugin, type JsonObject, type Page, type Topic } from "../api";
import { ChannelFields } from "../components/ChannelFields";
import { RowAction, Confirm, Drawer, Empty, Failure, JsonInput, More, object, PageTitle, Progress, useDate } from "../components/Common";
import { configDefaults, pluginLabel, serializeConfig } from "../form-values";
import { useLanguage, useT } from "../preferences";
import { useMutation, usePage, useResource } from "../resources";

type ScheduleRule =
  | { kind: "interval"; minutes: number }
  | { kind: "weekly"; weekdays: number[]; time: string; time_zone: string }
  | { kind: "once"; at: number };

const intervalUnits = { minutes: 1, hours: 60, days: 1440 };
const weekdays = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

// A browser may normalize a nonexistent local time forward during a DST transition.
function localTimestamp(value: string) {
  const local = new Date(value);
  const epoch = local.getTime();
  if (!Number.isFinite(epoch)) return NaN;
  return toLocalInput(epoch) === value ? epoch : NaN;
}

function toLocalInput(epoch: number) {
  const offset = new Date(epoch).getTimezoneOffset() * 60_000;
  return new Date(epoch - offset).toISOString().slice(0, 16);
}

type Schedule = {
  id: string; name: string; plugin_id: string; topic: string | null; rule: ScheduleRule;
  enabled: boolean; completed: boolean; next_at: number | null; last_at: number | null; last_status: string | null; last_count: number;
};

type ScheduleDetail = Schedule & { config: JsonObject | null };

export default function Schedules({ api }: { api: Api }) {
  const t = useT();
  const date = useDate();
  const preset = new URLSearchParams(location.search).get("plugin") ?? "";
  const [editor, setEditor] = useState<string | "new" | undefined>(preset ? "new" : undefined);
  const [removing, setRemoving] = useState<Schedule>();
  const task = useMutation();
  const list = usePage<Schedule>(api, "/schedules");
  const language = useLanguage();
  const catalog = useResource<Page<InstalledPlugin>>(api, "/plugins");
  const plugins = (catalog.data?.items ?? []).filter((plugin) => plugin.kind === "task");
  const cadence = (rule: ScheduleRule) => {
    if (rule.kind === "once") return t("单次执行");
    if (rule.kind === "weekly") {
      const days = new Intl.ListFormat(language).format(
        weekdays.filter((_, index) => rule.weekdays.includes(index + 1)).map((day) => t(day)),
      );
      return `${days} · ${rule.time} (${rule.time_zone})`;
    }
    if (rule.minutes % intervalUnits.days === 0) return t("每 {count} 天", { count: rule.minutes / intervalUnits.days });
    if (rule.minutes % intervalUnits.hours === 0) return t("每 {count} 小时", { count: rule.minutes / intervalUnits.hours });
    return t("每 {count} 分钟", { count: rule.minutes });
  };
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
  return <>
    <PageTitle title={t("定时任务")} description={t("定时运行任务插件，把生成的通知发送到指定主题或默认路由。")}
      action={<div className="row-actions">
        <EuiButtonEmpty size="s" iconType="refresh" onClick={list.reload}>{t("刷新")}</EuiButtonEmpty>
        <EuiButton size="s" fill iconType="plusCircle" onClick={() => setEditor("new")}>{t("创建定时推送")}</EuiButton>
      </div>} />
    <Failure message={list.error ?? catalog.error} retry={() => { list.reload(); catalog.reload(); }} />
    {!removing && <Failure message={task.error} />}
    {list.loading ? <Progress /> : list.items.length ? <div className="data-surface">
      <EuiBasicTable<Schedule> tableCaption={t("任务计划")} rowHeader="name" itemId="id" items={list.items} columns={[
        { field: "name", name: t("名称"), render: (_, item) => <div><strong>{item.name}</strong><p className="muted">{pluginName(item.plugin_id)}</p></div> },
        { field: "topic", name: t("发送到"), render: (topic: string | null) => topic || t("默认路由") },
        { field: "next_at", name: t("下次执行"), render: (_, item) => <div>
          {item.completed ? <EuiBadge>{t("已结束")}</EuiBadge> : item.enabled ? date(item.next_at) : <EuiBadge>{t("已暂停")}</EuiBadge>}
          <p className="muted">{cadence(item.rule)}</p>
        </div> },
        { field: "last_status", name: t("最近执行"), render: (_, item) => !item.last_at ? "—" : <div>
          {item.last_status === "success" ? t("已入队 {count} 条", { count: String(item.last_count) }) : t(item.last_status === "paused" ? "已暂停" : "执行失败")}
          <p className="muted">{date(item.last_at)}{item.last_status !== "success" && item.last_status !== "paused" && item.last_status ? ` · ${item.last_status}` : ""}</p></div> },
        { name: t("操作"), render: (item: Schedule) => <div className="row-actions">
          <RowAction icon="pencil" onClick={() => setEditor(item.id)}>{t("编辑")}</RowAction>
          <RowAction icon="play" disabled={task.busy || !item.enabled} onClick={() => void update(item, "run")}>{t("立即执行")}</RowAction>
          <RowAction icon={item.enabled ? "pause" : "play"} disabled={task.busy || item.completed} onClick={() => void update(item, "toggle")}>{t(item.enabled ? "暂停" : "恢复")}</RowAction>
          <RowAction icon="trash" danger disabled={task.busy} onClick={() => { task.clear(); setRemoving(item); }}>{t("删除")}</RowAction>
        </div> },
      ]} />
      <More next={list.next} busy={list.busy} load={() => void list.loadMore()} />
    </div> : !list.error && <Empty title={t("还没有定时推送")} />}
    {editor && <OpenScheduleEditor key={editor} api={api} plugins={plugins} preset={preset} nameOf={pluginName}
      scheduleId={editor === "new" ? undefined : editor}
      close={() => setEditor(undefined)} done={() => { setEditor(undefined); list.reload(); }} />}
    {removing && <Confirm title={t("删除「{name}」？", { name: removing.name })} label={t("删除")} busy={task.busy}
      close={() => setRemoving(undefined)} confirm={() => void update(removing, "delete")}>
      <Failure message={task.error} />
    </Confirm>}
  </>;
}

type EditorProps = {
  api: Api; plugins: InstalledPlugin[]; preset: string; nameOf: (id: string) => string; close: () => void; done: () => void;
};

function OpenScheduleEditor({ scheduleId, ...props }: EditorProps & { scheduleId?: string }) {
  const t = useT();
  const detail = useResource<ScheduleDetail>(props.api, scheduleId ? `/schedules/${segment(scheduleId)}` : undefined);
  if (!scheduleId || detail.data) return <ScheduleEditor {...props} schedule={detail.data} />;
  return <Drawer title={t("编辑定时任务")} close={props.close}>
    {detail.loading ? <Progress /> : <Failure message={detail.error} retry={detail.reload} />}
  </Drawer>;
}

function ScheduleEditor({ api, plugins, preset, nameOf, close, done, schedule }: EditorProps & { schedule?: ScheduleDetail }) {
  const t = useT();
  const id = useId();
  const initial = schedule?.rule;
  const [name, setName] = useState(schedule?.name ?? "");
  const [pluginId, setPluginId] = useState(schedule?.plugin_id ?? preset);
  const [config, setConfig] = useState<JsonObject>();
  const [source, setSource] = useState("");
  const [replaceInput, setReplaceInput] = useState(false);
  const [start, setStart] = useState("");
  const [kind, setKind] = useState<ScheduleRule["kind"]>(initial?.kind ?? "interval");
  const [interval, setInterval] = useState(String(initial?.kind === "interval" ? initial.minutes : 60));
  const [unit, setUnit] = useState<keyof typeof intervalUnits>("minutes");
  const [days, setDays] = useState<Record<string, boolean>>(
    Object.fromEntries(initial?.kind === "weekly" ? initial.weekdays.map((day) => [day, true]) : []),
  );
  const [time, setTime] = useState(initial?.kind === "weekly" ? initial.time : "09:00");
  const [once, setOnce] = useState(initial?.kind === "once" ? toLocalInput(initial.at) : "");
  const [localZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [zone, setZone] = useState(initial?.kind === "weekly" ? initial.time_zone : localZone);
  const [zoneOptions] = useState(() =>
    Array.from(new Set([zone, localZone, "UTC", ...(Intl.supportedValuesOf?.("timeZone") ?? [])])).sort(),
  );
  const [topic, setTopic] = useState(schedule?.topic ?? "");
  const topics = usePage<Topic>(api, "/topics");
  const task = useMutation();
  const plugin = plugins.find(({ id }) => id === pluginId);
  const samePlugin = pluginId === schedule?.plugin_id;
  const storedConfig = samePlugin ? schedule?.config : undefined;
  const fields = config ?? storedConfig ?? (plugin ? configDefaults(plugin.config_schema) : {});
  const taskInput = plugin && (plugin.config_schema["x-anser-ui"] as { task_input?: string } | undefined)?.task_input !== "none";
  const canSave = !!plugin || samePlugin;

  return <Drawer title={t(schedule ? "编辑定时任务" : "创建定时推送")} close={close}
    footer={<><EuiButtonEmpty onClick={close}>{t("取消")}</EuiButtonEmpty>
      <EuiButton type="submit" form={id} fill isLoading={task.busy} disabled={!canSave}>{t("保存计划")}</EuiButton></>}>
    <form id={id} className="stack" onSubmit={(event) => { event.preventDefault(); if (!canSave) return;
      void task.run(async () => {
        let rule: ScheduleRule | undefined;
        let startAt: number | undefined;
        if (kind === "interval") {
          const minutes = Number(interval) * intervalUnits[unit];
          if (initial?.kind !== kind || initial.minutes !== minutes) rule = { kind, minutes };
          if (start) {
            startAt = localTimestamp(start);
            if (!Number.isFinite(startAt)) throw new Error(t("请输入有效的开始时间。"));
          }
        } else if (kind === "weekly") {
          const selected = weekdays.map((_, index) => index + 1).filter((day) => days[String(day)]);
          if (!selected.length) throw new Error(t("请至少选择一个执行日。"));
          if (initial?.kind !== kind || initial.time !== time || initial.time_zone !== zone
              || selected.length !== initial.weekdays.length || !selected.every((day) => initial.weekdays.includes(day))) {
            rule = { kind, weekdays: selected, time, time_zone: zone };
          }
        } else if (initial?.kind !== kind || toLocalInput(initial.at) !== once) {
          const at = localTimestamp(once);
          if (!Number.isFinite(at) || at <= Date.now()) throw new Error(t("请选择未来有效的执行日期和时间。"));
          rule = { kind, at };
        }
        const replacing = !samePlugin || !!config;
        const input = taskInput && (!samePlugin || replaceInput) ? object(source || "{}") : undefined;
        await api.write(schedule ? `/schedules/${segment(schedule.id)}` : "/schedules", schedule ? "PATCH" : "POST",
          { name: name.trim(), plugin_id: pluginId, rule, topic: topic || null, start_at: startAt,
            config: plugin && replacing ? serializeConfig(plugin, fields) : undefined,
            input: schedule ? input : input ?? null });
        done();
      });
    }}>
      <Failure message={task.error} />
      <EuiFormRow label={t("名称")} fullWidth><EuiFieldText fullWidth required value={name} onChange={(event) => setName(event.target.value)} /></EuiFormRow>
      <EuiFormRow label={t("任务插件")} fullWidth><EuiSelect fullWidth required value={pluginId}
        onChange={(event) => { setPluginId(event.target.value); setConfig(undefined); setSource(""); setReplaceInput(false); }}
        options={[{ value: "", text: t("请选择") },
          ...(!plugin && samePlugin ? [{ value: pluginId, text: pluginId }] : []),
          ...plugins.map(({ id }) => ({ value: id, text: nameOf(id) }))]} /></EuiFormRow>
      {plugin && (!samePlugin || storedConfig) && <ChannelFields key={plugin.id} channel={plugin} value={fields} update={setConfig} />}
      {taskInput && samePlugin && <EuiSwitch label={t("替换任务输入")} checked={replaceInput}
        onChange={(event) => setReplaceInput(event.target.checked)} />}
      {taskInput && (!samePlugin || replaceInput) && <JsonInput label={t("任务输入")} value={source} set={setSource} />}
      <EuiFormRow label={t("发送到")} fullWidth><EuiSelect fullWidth value={topic} onChange={(event) => setTopic(event.target.value)}
        options={[{ value: "", text: t("默认路由") },
          ...(topic && !topics.items.some(({ enabled, name }) => enabled && name === topic) ? [{ value: topic, text: topic }] : []),
          ...topics.items.filter(({ enabled }) => enabled).map(({ name }) => ({ value: name, text: name }))]} /></EuiFormRow>
      <Failure message={topics.error} retry={topics.reload} />
      <More next={topics.next} busy={topics.busy} load={() => void topics.loadMore()} />
      <EuiFormRow label={t("执行方式")} fullWidth><EuiSelect fullWidth value={kind}
        onChange={(event) => setKind(event.target.value as ScheduleRule["kind"])}
        options={[
          { value: "interval", text: t("固定间隔") },
          { value: "weekly", text: t("每周重复") },
          { value: "once", text: t("单次执行") },
        ]} />
      </EuiFormRow>
      {kind === "interval" && <>
        <EuiFlexGroup gutterSize="s" alignItems="flexStart">
          <EuiFlexItem><EuiFormRow label={t("执行间隔")} fullWidth>
            <EuiFieldNumber fullWidth required min={1} max={43200 / intervalUnits[unit]} step={1}
              value={interval} onChange={(event) => setInterval(event.target.value)} />
          </EuiFormRow></EuiFlexItem>
          <EuiFlexItem><EuiFormRow label={t("间隔单位")} fullWidth><EuiSelect fullWidth value={unit}
            onChange={(event) => setUnit(event.target.value as keyof typeof intervalUnits)}
            options={[
              { value: "minutes", text: t("分钟") },
              { value: "hours", text: t("小时") },
              { value: "days", text: t("天") },
            ]} />
          </EuiFormRow></EuiFlexItem>
        </EuiFlexGroup>
        <EuiFormRow label={t(schedule ? "调整下次执行时间" : "首次执行时间")}
          helpText={t(schedule ? "时区 {zone}。仅修改间隔时，从保存时重新计时。" : "时区 {zone}。留空则在一个执行间隔后运行。", { zone: localZone })} fullWidth>
          <EuiFieldText fullWidth type="datetime-local" value={start} onChange={(event) => setStart(event.target.value)} />
        </EuiFormRow>
      </>}
      {kind === "weekly" && <>
        <EuiFormRow label={t("在这些星期执行")} labelType="legend" fullWidth><EuiCheckboxGroup
          options={weekdays.map((day, index) => ({ id: String(index + 1), label: t(day) }))}
          idToSelectedMap={days} onChange={(day) => setDays((current) => ({ ...current, [day]: !current[day] }))} />
        </EuiFormRow>
        <EuiFormRow label={t("执行时间")} fullWidth>
          <EuiFieldText fullWidth required type="time" value={time} onChange={(event) => setTime(event.target.value)} />
        </EuiFormRow>
        <EuiFormRow label={t("时区")} fullWidth><EuiSelect fullWidth value={zone}
          onChange={(event) => setZone(event.target.value)}
          options={zoneOptions.map((value) => ({ value, text: value }))} />
        </EuiFormRow>
      </>}
      {kind === "once" && <EuiFormRow label={t("执行日期和时间")} helpText={t("时区 {zone}。", { zone: localZone })} fullWidth>
        <EuiFieldText fullWidth required type="datetime-local" value={once} onChange={(event) => setOnce(event.target.value)} />
      </EuiFormRow>}
    </form>
  </Drawer>;
}
