import { useId, useState } from "react";
import {
  EuiBadge, EuiBasicTable, EuiButton, EuiButtonEmpty, EuiCallOut, EuiCheckboxGroup, EuiCopy, EuiFieldPassword,
  EuiFieldText, EuiFormRow, EuiSwitch, EuiText,
} from "@elastic/eui";
import { QRCodeCanvas } from "qrcode.react";
import { Api, segment, type Account, type ApiKey, type Channel, type IssuedKey, type MessageDetail, type Page, type PairCode, type Policy, type User } from "../api";
import { Confirm, date, Drawer, Empty, Failure, More, PageTitle, Progress, Tags } from "../components/Common";
import { PolicyFields } from "../components/PolicyFields";
import { useMutation, usePage, useResource } from "../resources";
import { MessageTable } from "./Delivery";

export function Dashboard({ api, navigate }: { api: Api; navigate: (path: string) => void }) {
  const stats = useResource<Record<string, number>>(api, "/statistics");
  const latest = useResource<Page<MessageDetail>>(api, "/messages?limit=8");
  const numbers = [
    ["queue_depth", "队列中", "等待分发的路由", "waiting"],
    ["delivery_success", "已送达", "成功的渠道投递", "success"],
    ["delivery_dead", "死信", "超出重试有效期", "danger"],
    ["retries", "重试", "已记录的重试次数", "neutral"],
  ] as const;

  return <>
    <PageTitle title="投递总览" description="查看通知队列、送达结果和最近的投递。"
      action={<EuiButton fill iconType="plusCircle" onClick={() => navigate("/admin/send")}>发送通知</EuiButton>} />
    <Failure message={stats.error} retry={stats.reload} />
    <dl className="metrics" aria-label="队列与送达统计">{numbers.map(([key, label, detail, kind]) => <div key={key} className={`metric metric-${kind}`}>
      <dt>{label}</dt>
      <dd><strong>{stats.data ? new Intl.NumberFormat("zh-CN").format(stats.data[key] ?? 0) : "—"}</strong><small>{detail}</small></dd>
    </div>)}</dl>
    <section className="stack">
      <div className="section-header"><h2>最近投递</h2><EuiButtonEmpty size="s" onClick={() => navigate("/admin/messages")}>全部记录</EuiButtonEmpty></div>
      <Failure message={latest.error} retry={latest.reload} />
      {latest.loading ? <Progress /> : latest.data?.items.length ? <div className="data-surface"><MessageTable items={latest.data.items} navigate={navigate} /></div>
        : <Empty title="还没有投递记录" description="发送消息后，会在这里显示当前状态。" />}
    </section>
  </>;
}

export function DefaultRoute({ api }: { api: Api }) {
  const policy = useResource<Policy>(api, "/default-route");
  const channels = useResource<Page<Channel>>(api, "/channels");
  const accounts = usePage<Account>(api, "/accounts");
  return <>
    <PageTitle title="默认路由" description="未指定主题和渠道的直接投递使用此策略。" />
    <Failure message={policy.error ?? channels.error ?? accounts.error} retry={() => { policy.reload(); channels.reload(); accounts.reload(); }} />
    {policy.loading && <Progress />}
    {policy.data && <DefaultRouteForm api={api} initial={policy.data} accounts={accounts.items} channels={channels.data?.items ?? []}
      onMore={accounts.next ? () => void accounts.loadMore() : undefined} />}
  </>;
}

function DefaultRouteForm({ api, initial, channels, accounts, onMore }: {
  api: Api; initial: Policy; channels: Channel[]; accounts: Account[]; onMore?: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [saved, setSaved] = useState(false);
  const task = useMutation();
  return <form className="compose-form form-surface stack" onSubmit={(event) => {
    event.preventDefault(); setSaved(false);
    void task.run(async () => {
      const result = await api.write<Policy>("/default-route", "PUT", value);
      setValue(result); setSaved(true);
    });
  }}>
    <Failure message={task.error} />
    {saved && <EuiCallOut title="默认路由已保存" color="success" iconType="check" announceOnMount size="s" />}
    <PolicyFields value={value} update={(next) => { setValue(next); setSaved(false); }} channels={channels} accounts={accounts} />
    {onMore && <EuiButtonEmpty size="xs" onClick={onMore}>加载更多可选账号</EuiButtonEmpty>}
    <div className="form-actions"><EuiButton fill type="submit" isLoading={task.busy}>保存默认路由</EuiButton></div>
  </form>;
}

export function Users({ api }: { api: Api }) {
  const users = usePage<User>(api, "/users");
  const [editing, setEditing] = useState<User | "new">();
  return <>
    <PageTitle title="用户" description="创建登录账号，管理启用状态和管理员权限。"
      action={<EuiButton fill iconType="plusCircle" onClick={() => setEditing("new")}>新增用户</EuiButton>} />
    <Failure message={users.error} retry={users.reload} />
    {users.loading ? <Progress /> : users.items.length ? <div className="data-surface">
      <EuiBasicTable<User> rowHeader="username" tableCaption="Anser 用户" items={users.items} itemId="id" columns={[
        { field: "username", name: "用户名",
          render: (name, item) => <EuiButtonEmpty size="xs" flush="left" onClick={() => setEditing(item)}>{name}</EuiButtonEmpty> },
        { field: "admin", name: "权限", render: (value: boolean) => value ? "管理员" : "普通用户" },
        { field: "enabled", name: "状态", render: (value: boolean) => <EuiBadge color={value ? "success" : "default"}>{value ? "启用" : "停用"}</EuiBadge> },
        { field: "created_at", name: "创建时间", render: date },
      ]} />
      <More next={users.next} busy={users.busy} load={() => void users.loadMore()} />
    </div> : <Empty title="暂无用户" description="新增用户后，可用密码登录与配对客户端。" />}
    {editing && <UserEditor api={api} user={editing === "new" ? undefined : editing} close={() => setEditing(undefined)}
      done={() => { setEditing(undefined); users.reload(); }} />}
  </>;
}

function UserEditor({ api, user, close, done }: { api: Api; user?: User; close: () => void; done: () => void }) {
  const [username, setUsername] = useState(user?.username ?? "");
  const [password, setPassword] = useState("");
  const [enabled, setEnabled] = useState(user?.enabled ?? true);
  const [admin, setAdmin] = useState(user?.admin ?? false);
  const id = useId();
  const task = useMutation();
  return <Drawer title={user ? "编辑用户" : "新增用户"} close={close}
    footer={<EuiButton form={id} type="submit" fill isLoading={task.busy}>保存用户</EuiButton>}>
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
      <EuiFormRow label="用户名" fullWidth><EuiFieldText fullWidth required disabled={!!user} value={username} onChange={(event) => setUsername(event.target.value)} /></EuiFormRow>
      <EuiFormRow label={user ? "新密码（留空则保留）" : "密码"} fullWidth>
        <EuiFieldPassword fullWidth type="password" autoComplete="new-password" required={!user} minLength={8}
          value={password} onChange={(event) => setPassword(event.target.value)} />
      </EuiFormRow>
      <EuiSwitch label="拥有管理员权限" checked={admin} onChange={(event) => setAdmin(event.target.checked)} />
      {user && <EuiSwitch label="启用账号" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />}
    </form>
  </Drawer>;
}

export function Keys({ api }: { api: Api }) {
  const list = usePage<ApiKey>(api, "/api-keys");
  const [creating, setCreating] = useState(false);
  const [issued, setIssued] = useState<IssuedKey>();
  const [confirming, setConfirming] = useState<{ key: ApiKey; operation: "rotate" | "disable" }>();
  const task = useMutation();
  return <>
    <PageTitle title="API Keys" description="为发送、订阅和自动化任务分配凭据。"
      action={<EuiButton fill iconType="plusCircle" onClick={() => setCreating(true)}>创建 Key</EuiButton>} />
    <Failure message={list.error} retry={list.reload} />
    {list.loading ? <Progress /> : list.items.length ? <div className="data-surface">
      <EuiBasicTable<ApiKey> rowHeader="name" tableCaption="API 凭据" items={list.items} itemId="id" columns={[
        { field: "name", name: "名称" },
        { field: "scopes", name: "作用域", render: (values: string[]) => <Tags values={values} /> },
        { field: "topic_prefix", name: "主题前缀", render: (value: string | null) => value || "全部" },
        { field: "expires_at", name: "到期时间", render: (value: number | null) => value ? date(value) : "无期限" },
        { field: "last_used_at", name: "最近使用", render: date },
        { field: "enabled", name: "状态", render: (value: boolean) => <EuiBadge color={value ? "success" : "default"}>{value ? "启用" : "停用"}</EuiBadge> },
        { name: "操作", render: (key: ApiKey) => key.enabled && <div className="row-actions">
          <EuiButtonEmpty size="xs" onClick={() => { task.clear(); setConfirming({ key, operation: "rotate" }); }}>轮换</EuiButtonEmpty>
          <EuiButtonEmpty size="xs" color="danger" onClick={() => { task.clear(); setConfirming({ key, operation: "disable" }); }}>停用</EuiButtonEmpty>
        </div> },
      ]} />
      <More next={list.next} busy={list.busy} load={() => void list.loadMore()} />
    </div> : <Empty title="暂无 API Key" description="创建一个具有所需作用域的 Key。" />}
    {creating && <KeyEditor api={api} close={() => setCreating(false)} done={(key) => { setCreating(false); setIssued(key); list.reload(); }} />}
    {confirming && <Confirm title={confirming.operation === "rotate" ? "轮换 API Key？" : "停用 API Key？"}
      label={confirming.operation === "rotate" ? "确认轮换" : "确认停用"} busy={task.busy}
      close={() => setConfirming(undefined)} confirm={() => void task.run(async () => {
        const path = `/api-keys/${segment(confirming.key.id)}`;
        if (confirming.operation === "rotate") setIssued(await api.write<IssuedKey>(`${path}/rotate`, "POST"));
        else await api.write(path, "DELETE");
        setConfirming(undefined); list.reload();
      })}>
      <p>「{confirming.key.name}」的旧凭据会立即失效。</p><Failure message={task.error} />
    </Confirm>}
    {issued && <Drawer title="保存新的 API Key" close={() => setIssued(undefined)} size="s"
      footer={<EuiButton onClick={() => setIssued(undefined)}>完成</EuiButton>}>
      <div className="stack">
        <EuiCallOut color="warning" iconType="warning" title="完整 Key 只显示这一次，请复制到安全的凭据存储位置。" />
        <code className="new-token">{issued.token}</code>
        <EuiCopy textToCopy={issued.token}>
          {(copy: () => void) => <EuiButtonEmpty iconType="copy" onClick={copy}>复制 Key</EuiButtonEmpty>}
        </EuiCopy>
      </div>
    </Drawer>}
  </>;
}

function KeyEditor({ api, close, done }: { api: Api; close: () => void; done: (key: IssuedKey) => void }) {
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<Record<string, boolean>>({ send: true });
  const [prefix, setPrefix] = useState("");
  const [expiry, setExpiry] = useState("");
  const id = useId();
  const task = useMutation();
  return <Drawer title="创建 API Key" close={close} size="s"
    footer={<EuiButton type="submit" form={id} fill isLoading={task.busy}>生成 Key</EuiButton>}>
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
      <EuiFormRow label="Key 名称" fullWidth><EuiFieldText fullWidth required value={name} onChange={(event) => setName(event.target.value)} /></EuiFormRow>
      <EuiFormRow label="作用域" fullWidth><EuiCheckboxGroup
        options={[{ id: "send", label: "发送" }, { id: "subscribe", label: "订阅" }, { id: "admin", label: "管理" }]} idToSelectedMap={scopes}
        onChange={(scope) => setScopes((value) => ({ ...value, [scope]: !value[scope] }))} /></EuiFormRow>
      <EuiFormRow label="主题前缀（可选）" fullWidth><EuiFieldText fullWidth value={prefix} onChange={(event) => setPrefix(event.target.value)} /></EuiFormRow>
      <EuiFormRow label="到期时间（可选）" fullWidth><EuiFieldText fullWidth type="datetime-local" value={expiry} onChange={(event) => setExpiry(event.target.value)} /></EuiFormRow>
    </form>
  </Drawer>;
}

export function Pair({ api }: { api: Api }) {
  const [server, setServer] = useState(window.location.origin);
  const [pair, setPair] = useState<PairCode>();
  const task = useMutation();
  return <>
    <PageTitle title="配对客户端" description="用雁字客户端扫描二维码，为当前用户建立会话。" />
    <div className="pair-layout">
      <form className="form-surface stack" onSubmit={(event) => {
        event.preventDefault();
        setPair(undefined);
        void task.run(async () => setPair(await api.write<PairCode>("/auth/pair", "POST", { server: server.trim() || undefined })));
      }}>
        <Failure message={task.error} />
        <EuiFormRow label="客户端可访问的服务器地址" helpText="服务器配置了 ANSER_PUBLIC_URL 时，以服务端配置为准。" fullWidth>
          <EuiFieldText fullWidth type="url" required value={server} onChange={(event) => setServer(event.target.value)} />
        </EuiFormRow>
        <div className="form-actions"><EuiButton type="submit" fill iconType="link" isLoading={task.busy}>生成配对码</EuiButton></div>
      </form>
      {pair && <section className="pair-code stack" aria-label="配对二维码">
        <QRCodeCanvas value={pair.url} size={228} marginSize={3} title="雁字客户端配对二维码" />
        <EuiText textAlign="center" size="s" color="subdued"><p>有效期至 {date(pair.expires_at)}，配对码仅可使用一次。</p></EuiText>
        <EuiCopy textToCopy={pair.url}>
          {(copy: () => void) => <EuiButtonEmpty iconType="copy" onClick={copy}>复制配对链接</EuiButtonEmpty>}
        </EuiCopy>
      </section>}
    </div>
  </>;
}
