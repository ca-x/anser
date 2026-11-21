import { useId, useState } from "react";
import {
  EuiBadge, EuiBasicTable, EuiButton, EuiButtonEmpty, EuiFieldPassword,
  EuiFieldText, EuiFormRow, EuiSwitch,
} from "@elastic/eui";
import { Api, ApiError, segment, type OutboundProxy } from "../api";
import { Confirm, Drawer, Empty, Failure, More, PageTitle, Progress } from "../components/Common";
import { useT } from "../preferences";
import { useMutation, usePage } from "../resources";

export function Proxies({ api }: { api: Api }) {
  const t = useT();
  const list = usePage<OutboundProxy>(api, "/proxies");
  const [editor, setEditor] = useState<OutboundProxy | "new">();
  const [removing, setRemoving] = useState<OutboundProxy>();
  const remove = useMutation();

  return <>
    <PageTitle title={t("出站代理")} description={t("创建可供渠道账号共用的代理连接。")}
      action={<EuiButton fill iconType="plusCircle" onClick={() => setEditor("new")}>{t("新增代理配置")}</EuiButton>} />
    <Failure message={list.error} retry={list.reload} />
    {list.loading ? <Progress /> : list.items.length > 0 ? <div className="data-surface">
      <EuiBasicTable<OutboundProxy> rowHeader="name" tableCaption={t("共享代理配置")} itemId="id" items={list.items} columns={[
        { field: "name", name: t("名称"), render: (name, item) =>
          <EuiButtonEmpty size="xs" flush="left" onClick={() => setEditor(item)}>{name}</EuiButtonEmpty> },
        { field: "url", name: t("代理地址"), textOnly: true },
        { field: "authenticated", name: t("身份验证"), render: (authenticated: boolean) =>
          <EuiBadge color={authenticated ? "primary" : "default"}>{t(authenticated ? "已配置凭据" : "无凭据")}</EuiBadge> },
        { name: t("操作"), render: (proxy: OutboundProxy) =>
          <EuiButtonEmpty size="xs" color="danger" onClick={() => { remove.clear(); setRemoving(proxy); }}>{t("删除")}</EuiButtonEmpty> },
      ]} />
      <More next={list.next} busy={list.busy} load={() => { void list.loadMore(); }} />
    </div> : !list.error && <Empty title={t("还没有共享代理")} description={t("添加代理后，在支持代理的渠道账号中选择它。")} />}
    {editor && <ProxyEditor api={api} proxy={editor === "new" ? undefined : editor} close={() => setEditor(undefined)}
      done={() => { setEditor(undefined); list.reload(); }} />}
    {removing && <Confirm title={t("删除代理「{name}」？", { name: removing.name })} label={t("删除代理配置")} busy={remove.busy}
      close={() => setRemoving(undefined)} confirm={() => { void remove.run(async () => {
        try {
          await api.write(`/proxies/${segment(removing.id)}`, "DELETE");
        } catch (error) {
          if (error instanceof ApiError && error.status === 409) throw new Error("此代理仍被渠道账号使用，请先解除关联。");
          throw error;
        }
        setRemoving(undefined);
        list.reload();
      }); }}>
      <p>{t("将此配置从渠道账号的代理选项中移除。")}</p>
      <Failure message={remove.error} />
    </Confirm>}
  </>;
}

function ProxyEditor({ api, proxy, close, done }: { api: Api; proxy?: OutboundProxy; close: () => void; done: () => void }) {
  const t = useT();
  const id = useId();
  const [name, setName] = useState(proxy?.name ?? "");
  const [replace, setReplace] = useState(false);
  const [url, setUrl] = useState(proxy?.url ?? "");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const task = useMutation();
  const hasConnectionFields = !proxy || replace;
  const closeWhenIdle = () => { if (!task.busy) close(); };
  return <Drawer size="s" title={t(proxy ? "编辑代理配置" : "新增代理配置")} close={closeWhenIdle}
    footer={<>
      <EuiButtonEmpty disabled={task.busy} onClick={closeWhenIdle}>{t("取消")}</EuiButtonEmpty>
      <EuiButton fill type="submit" form={id} isLoading={task.busy}>{t("保存代理配置")}</EuiButton>
    </>}>
    <form id={id} className="stack" onSubmit={(event) => {
      event.preventDefault();
      void task.run(async () => {
        const connection = hasConnectionFields ? { url: proxyOrigin(url), username: username || undefined, password: password || undefined } : undefined;
        await api.write(proxy ? `/proxies/${segment(proxy.id)}` : "/proxies", proxy ? "PUT" : "POST", { name: name.trim(), ...connection });
        done();
      });
    }}>
      <Failure message={task.error} />
      <EuiFormRow label={t("名称")} fullWidth>
        <EuiFieldText required readOnly={task.busy} fullWidth value={name} onChange={(event) => setName(event.target.value)} />
      </EuiFormRow>
      {proxy && <EuiSwitch label={t("替换连接和凭据")} disabled={task.busy} checked={replace} onChange={(event) => {
        setReplace(event.target.checked);
        setUrl(proxy.url);
        setUsername("");
        setPassword("");
      }} />}
      {hasConnectionFields && <>
        <EuiFormRow label={t("代理地址")} helpText={t("输入代理的 HTTP 或 HTTPS 地址及端口。凭据请填写在下方。")} fullWidth>
          <EuiFieldText type="url" required readOnly={task.busy} fullWidth placeholder="http://proxy.example.com:3128"
            value={url} onChange={(event) => setUrl(event.target.value)} />
        </EuiFormRow>
        <EuiFormRow label={t("代理用户名")} helpText={t("用户名和密码一起填写。无需身份验证时，两项都留空。")} fullWidth>
          <EuiFieldText fullWidth readOnly={task.busy} required={password !== ""} autoComplete="off" autoCapitalize="none"
            spellCheck={false} value={username} onChange={(event) => setUsername(event.target.value)} />
        </EuiFormRow>
        <EuiFormRow label={t("代理密码")} fullWidth>
          <EuiFieldPassword type="password" fullWidth readOnly={task.busy} required={username !== ""} autoComplete="new-password"
            value={password} onChange={(event) => setPassword(event.target.value)} />
        </EuiFormRow>
      </>}
    </form>
  </Drawer>;
}

function proxyOrigin(input: string) {
  let url: URL;
  const error = "请输入 HTTP 或 HTTPS 代理地址，无需附加凭据、路径或参数。";
  try { url = new URL(input.trim()); } catch { throw new Error(error); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(error);
  }
  return url.origin;
}
