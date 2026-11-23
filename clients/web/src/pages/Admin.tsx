import { useLanguage, useT } from "../preferences";
import { useId, useState } from "react";
import {
  EuiBadge, EuiBasicTable, EuiButton, EuiButtonEmpty, EuiCallOut, EuiCheckboxGroup, EuiCopy, EuiFieldPassword,
  EuiFieldText, EuiFormRow, EuiIcon, EuiSwitch,
} from "@elastic/eui";
import { Api, segment, type Account, type ApiKey, type Channel, type IssuedKey, type MessageDetail, type Page, type Policy, type User } from "../api";
import { Confirm, useDate, Drawer, Empty, Failure, More, PageTitle, Progress, Tags } from "../components/Common";
import { PolicyFields } from "../components/PolicyFields";
import { useMutation, usePage, useResource } from "../resources";
import { MessageTable } from "./Delivery";

export function Dashboard({ api, navigate }: { api: Api; navigate: (path: string) => void }) {
  const t = useT();
  const language = useLanguage();
  const stats = useResource<Record<string, number>>(api, "/statistics");
  const latest = useResource<Page<MessageDetail>>(api, "/messages?limit=8");
  const numbers = [
    ["queue_depth", t("队列中"), t("等待分发的路由"), "waiting", "clock"],
    ["delivery_success", t("已送达"), t("成功的渠道投递"), "success", "checkInCircleFilled"],
    ["delivery_dead", t("死信"), t("超出重试有效期"), "danger", "warning"],
    ["retries", t("重试"), t("已记录的重试次数"), "neutral", "refresh"],
  ] as const;

  return <>
    <PageTitle title={t("投递总览")} description={t("查看通知队列、送达结果和最近的投递。")}
      action={<EuiButton fill iconType="plusCircle" onClick={() => navigate("/admin/send")}>{t("发送通知")}</EuiButton>} />
    <Failure message={stats.error} retry={stats.reload} />
    <dl className="metrics" aria-label={t("队列与送达统计")}>{numbers.map(([key, label, detail, kind, icon]) => <div key={key} className={`metric metric-${kind}`}>
      <dt><EuiIcon type={icon} aria-hidden="true" />{label}</dt>
      <dd><strong>{stats.data ? new Intl.NumberFormat(language).format(stats.data[key] ?? 0) : "—"}</strong><small>{detail}</small></dd>
    </div>)}</dl>
    <section className="stack">
      <div className="section-header"><h2>{t("最近投递")}</h2><EuiButtonEmpty size="s" onClick={() => navigate("/admin/messages")}>{t("全部记录")}</EuiButtonEmpty></div>
      <Failure message={latest.error} retry={latest.reload} />
      {latest.loading ? <Progress /> : latest.data?.items.length ? <div className="data-surface"><MessageTable items={latest.data.items} navigate={navigate} /></div>
        : !latest.error && <Empty title={t("还没有投递记录")} description={t("发送消息后，会在这里显示当前状态。")} />}
    </section>
  </>;
}

export function DefaultRoute({ api }: { api: Api }) {
  const t = useT();
  const policy = useResource<Policy>(api, "/default-route");
  const channels = useResource<Page<Channel>>(api, "/channels");
  const accounts = usePage<Account>(api, "/accounts");
  return <>
    <PageTitle title={t("默认路由")} description={t("未指定主题和渠道的直接投递使用此策略。")} />
    <Failure message={policy.error ?? channels.error ?? accounts.error} retry={() => { policy.reload(); channels.reload(); accounts.reload(); }} />
    {policy.loading && <Progress />}
    {policy.data && <DefaultRouteForm api={api} initial={policy.data} accounts={accounts.items} channels={channels.data?.items ?? []}
      onMore={accounts.next ? () => void accounts.loadMore() : undefined} />}
  </>;
}

function DefaultRouteForm({ api, initial, channels, accounts, onMore }: {
  api: Api; initial: Policy; channels: Channel[]; accounts: Account[]; onMore?: () => void;
}) {
  const t = useT();
  const [value, setValue] = useState(initial);
  const [saved, setSaved] = useState<Policy>();
  const task = useMutation();
  return <form className="compose-form form-surface stack" onSubmit={(event) => {
    event.preventDefault(); setSaved(undefined);
    void task.run(async () => {
      const result = await api.write<Policy>("/default-route", "PUT", value);
      setValue((current) => current === value ? result : current);
      setSaved(result);
    });
  }}>
    <Failure message={task.error} />
    {saved === value && <EuiCallOut title={t("默认路由已保存")} color="success" iconType="check" announceOnMount size="s" />}
    <PolicyFields value={value} update={setValue} channels={channels} accounts={accounts} />
    {onMore && <EuiButtonEmpty size="xs" onClick={onMore}>{t("加载更多可选账号")}</EuiButtonEmpty>}
    <div className="form-actions"><EuiButton fill type="submit" isLoading={task.busy}>{t("保存默认路由")}</EuiButton></div>
  </form>;
}

export function Users({ api }: { api: Api }) {
  const t = useT();
  const date = useDate();
  const users = usePage<User>(api, "/users");
  const [editing, setEditing] = useState<User | "new">();
  return <>
    <PageTitle title={t("用户")} description={t("创建登录账号，管理启用状态和管理员权限。")}
      action={<EuiButton fill iconType="plusCircle" onClick={() => setEditing("new")}>{t("新增用户")}</EuiButton>} />
    <Failure message={users.error} retry={users.reload} />
    {users.loading ? <Progress /> : users.items.length ? <div className="data-surface">
      <EuiBasicTable<User> rowHeader="username" tableCaption={t("雁字用户")} items={users.items} itemId="id" columns={[
        { field: "username", name: t("用户名"),
          render: (name, item) => <EuiButtonEmpty size="xs" flush="left" onClick={() => setEditing(item)}>{name}</EuiButtonEmpty> },
        { field: "admin", name: t("权限"), render: (value: boolean) => value ? t("管理员") : t("普通用户") },
        { field: "enabled", name: t("状态"), render: (value: boolean) => <EuiBadge color={value ? "success" : "default"}>{value ? t("启用") : t("停用")}</EuiBadge> },
        { field: "created_at", name: t("创建时间"), render: date },
      ]} />
      <More next={users.next} busy={users.busy} load={() => void users.loadMore()} />
    </div> : !users.error && <Empty title={t("暂无用户")} description={t("新增用户后，可用密码登录与配对客户端。")} />}
    {editing && <UserEditor api={api} user={editing === "new" ? undefined : editing} close={() => setEditing(undefined)}
      done={() => { setEditing(undefined); users.reload(); }} />}
  </>;
}

function UserEditor({ api, user, close, done }: { api: Api; user?: User; close: () => void; done: () => void }) {
  const t = useT();
  const [username, setUsername] = useState(user?.username ?? "");
  const [password, setPassword] = useState("");
  const [enabled, setEnabled] = useState(user?.enabled ?? true);
  const [admin, setAdmin] = useState(user?.admin ?? false);
  const id = useId();
  const task = useMutation();
  return <Drawer title={user ? t("编辑用户") : t("新增用户")} close={close}
    footer={<EuiButton form={id} type="submit" fill isLoading={task.busy}>{t("保存用户")}</EuiButton>}>
    <form id={id} className="stack" onSubmit={(event) => {
      event.preventDefault();
      void task.run(async () => {
        const data = user ? { password: password || undefined, enabled: enabled !== user.enabled ? enabled : undefined, admin: admin !== user.admin ? admin : undefined }
          : { username: username.trim(), password, admin };
        await api.write(user ? `/users/${segment(user.id)}` : "/users", user ? "PUT" : "POST", data);
        done();
      });
    }}>
      <Failure message={task.error} />
      <EuiFormRow label={t("用户名")} fullWidth><EuiFieldText fullWidth required disabled={!!user} value={username} onChange={(event) => setUsername(event.target.value)} /></EuiFormRow>
      <EuiFormRow label={user ? t("新密码（留空则保留）") : t("密码")} fullWidth>
        <EuiFieldPassword fullWidth type="password" autoComplete="new-password" required={!user} minLength={8}
          value={password} onChange={(event) => setPassword(event.target.value)} />
      </EuiFormRow>
      <EuiSwitch label={t("拥有管理员权限")} checked={admin} onChange={(event) => setAdmin(event.target.checked)} />
      {user && <EuiSwitch label={t("启用账号")} checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />}
    </form>
  </Drawer>;
}

export function Keys({ api }: { api: Api }) {
  const t = useT();
  const date = useDate();
  const list = usePage<ApiKey>(api, "/api-keys");
  const [creating, setCreating] = useState(false);
  const [issued, setIssued] = useState<IssuedKey>();
  const [confirming, setConfirming] = useState<{ key: ApiKey; operation: "rotate" | "disable" }>();
  const task = useMutation();
  return <>
    <PageTitle title={t("API 密钥")} description={t("为发送、订阅和自动化任务分配凭据。")}
      action={<EuiButton fill iconType="plusCircle" onClick={() => setCreating(true)}>{t("创建密钥")}</EuiButton>} />
    <Failure message={list.error} retry={list.reload} />
    {list.loading ? <Progress /> : list.items.length ? <div className="data-surface">
      <EuiBasicTable<ApiKey> rowHeader="name" tableCaption={t("API 凭据")} items={list.items} itemId="id" columns={[
        { field: "name", name: t("名称") },
        { field: "scopes", name: t("作用域"), render: (values: string[]) => <Tags values={values} /> },
        { field: "topic_prefix", name: t("主题前缀"), render: (value: string | null) => value || t("全部") },
        { field: "expires_at", name: t("到期时间"), render: (value: number | null) => value ? date(value) : t("无期限") },
        { field: "last_used_at", name: t("最近使用"), render: date },
        { field: "enabled", name: t("状态"), render: (value: boolean) => <EuiBadge color={value ? "success" : "default"}>{value ? t("启用") : t("停用")}</EuiBadge> },
        { name: t("操作"), render: (key: ApiKey) => key.enabled && <div className="row-actions">
          <EuiButtonEmpty size="xs" onClick={() => { task.clear(); setConfirming({ key, operation: "rotate" }); }}>{t("轮换")}</EuiButtonEmpty>
          <EuiButtonEmpty size="xs" color="danger" onClick={() => { task.clear(); setConfirming({ key, operation: "disable" }); }}>{t("停用")}</EuiButtonEmpty>
        </div> },
      ]} />
      <More next={list.next} busy={list.busy} load={() => void list.loadMore()} />
    </div> : !list.error && <Empty title={t("暂无 API 密钥")} description={t("创建一个具有所需作用域的密钥。")} />}
    {creating && <KeyEditor api={api} close={() => setCreating(false)} done={(key) => { setCreating(false); setIssued(key); list.reload(); }} />}
    {confirming && <Confirm title={confirming.operation === "rotate" ? t("轮换 API 密钥？") : t("停用 API 密钥？")}
      label={confirming.operation === "rotate" ? t("确认轮换") : t("确认停用")} busy={task.busy}
      close={() => setConfirming(undefined)} confirm={() => void task.run(async () => {
        const path = `/api-keys/${segment(confirming.key.id)}`;
        if (confirming.operation === "rotate") setIssued(await api.write<IssuedKey>(`${path}/rotate`, "POST"));
        else await api.write(path, "DELETE");
        setConfirming(undefined); list.reload();
      })}>
      <p>{t("「{name}」的旧凭据会立即失效。", { name: confirming.key.name })}</p><Failure message={task.error} />
    </Confirm>}
    {issued && <Drawer title={t("保存新的 API 密钥")} close={() => setIssued(undefined)} size="s"
      footer={<EuiButton onClick={() => setIssued(undefined)}>{t("完成")}</EuiButton>}>
      <div className="stack">
        <EuiCallOut color="warning" iconType="warning" title={t("完整密钥只显示这一次，请复制到安全的凭据存储位置。")} />
        <code className="new-token">{issued.token}</code>
        <EuiCopy textToCopy={issued.token} afterMessage={t("已复制")}>
          {(copy: () => void) => <EuiButtonEmpty iconType="copy" onClick={copy}>{t("复制密钥")}</EuiButtonEmpty>}
        </EuiCopy>
      </div>
    </Drawer>}
  </>;
}

function KeyEditor({ api, close, done }: { api: Api; close: () => void; done: (key: IssuedKey) => void }) {
  const t = useT();
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<Record<string, boolean>>({ send: true });
  const [prefix, setPrefix] = useState("");
  const [expiry, setExpiry] = useState("");
  const id = useId();
  const task = useMutation();
  return <Drawer title={t("创建 API 密钥")} close={close} size="s"
    footer={<EuiButton type="submit" form={id} fill isLoading={task.busy}>{t("生成密钥")}</EuiButton>}>
    <form className="stack" id={id} onSubmit={(event) => {
      event.preventDefault();
      void task.run(async () => {
        const selected = Object.keys(scopes).filter((scope) => scopes[scope]);
        if (!selected.length) throw new Error("请选择至少一个作用域。");
        const expires = expiry ? new Date(expiry).getTime() : undefined;
        if (expires !== undefined && (!Number.isFinite(expires) || expires <= Date.now())) throw new Error("到期时间必须晚于现在。");
        done(await api.write<IssuedKey>("/api-keys", "POST", {
          name: name.trim(), scopes: selected, topic_prefix: prefix.trim() || undefined, expires_at: expires,
        }));
      });
    }}>
      <Failure message={task.error} />
      <EuiFormRow label={t("密钥名称")} fullWidth><EuiFieldText fullWidth required value={name} onChange={(event) => setName(event.target.value)} /></EuiFormRow>
      <EuiFormRow label={t("作用域")} fullWidth><EuiCheckboxGroup
        options={[{ id: "send", label: t("发送") }, { id: "subscribe", label: t("订阅") }, { id: "admin", label: t("管理") }]} idToSelectedMap={scopes}
        onChange={(scope) => setScopes((value) => ({ ...value, [scope]: !value[scope] }))} /></EuiFormRow>
      <EuiFormRow label={t("主题前缀（可选）")} fullWidth><EuiFieldText fullWidth value={prefix} onChange={(event) => setPrefix(event.target.value)} /></EuiFormRow>
      <EuiFormRow label={t("到期时间（可选）")} fullWidth><EuiFieldText fullWidth type="datetime-local" value={expiry} onChange={(event) => setExpiry(event.target.value)} /></EuiFormRow>
    </form>
  </Drawer>;
}
