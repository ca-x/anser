import { useChannelName, useT } from "../preferences";
import { useId, useState } from "react";
import {
  EuiAccordion, EuiBadge, EuiBasicTable, EuiButton, EuiButtonEmpty, EuiCallOut, EuiFieldNumber,
  EuiFieldText, EuiFormRow, EuiHorizontalRule, EuiSelect, EuiSwitch, EuiText,
} from "@elastic/eui";
import { Api, segment, type Account, type Channel, type JsonObject, type OutboundProxy, type Page } from "../api";
import { useMutation, usePage, useResource } from "../resources";
import { Confirm, Drawer, Empty, Failure, More, PageTitle, Progress, split, Tags } from "../components/Common";
import { blankMessage, Composer } from "../components/Composer";
import { ChannelFields, serializeConfig } from "../components/ChannelFields";

export function Accounts({ api }: { api: Api }) {
  const channels = useResource<Page<Channel>>(api, "/channels");
  return <>
    <Failure message={channels.error} retry={channels.reload} />
    <AccountList api={api} catalog={channels.data?.items ?? []} />
  </>;
}

export function AccountList({ api, catalog, channel }: {
  api: Api; catalog: Channel[]; channel?: Channel;
}) {
  const t = useT();
  const channelName = useChannelName();
  const list = usePage<Account>(api, channel ? `/accounts?channel=${segment(channel.id)}` : "/accounts");
  const items = channel ? list.items.filter((account) => account.channel === channel.id) : list.items;
  const [editor, setEditor] = useState<Account | "new">();
  const [testing, setTesting] = useState<Account>();
  const [removing, setRemoving] = useState<Account>();
  const action = useMutation();
  const available = catalog.filter(channelAvailable);
  const canTest = (account: Account) => {
    const plugin = catalog.find(({ id }) => id === account.channel);
    return channelAvailable(plugin);
  };
  const add = <EuiButton fill iconType="plusCircle" onClick={() => setEditor("new")} disabled={available.length === 0}>{t("新增账号")}</EuiButton>;

  return <>
    {channel
      ? <div className="section-header channel-accounts-heading"><h2>{t("渠道账号")}</h2>{add}</div>
      : <PageTitle title={t("渠道账号")} description={t("给通知渠道配置凭据、接收地址和投递权重。")} action={add} />}
    <Failure message={list.error} retry={list.reload} />
    {list.loading ? <Progress /> : items.length ? <div className="data-surface">
      <EuiBasicTable<Account> rowHeader="name" tableCaption={t("通知渠道账号")} items={items} itemId="id" columns={[
        { field: "name", name: t("账号"), render: (value, item) =>
          <EuiButtonEmpty size="xs" flush="left" onClick={() => setEditor(item)}>{value}</EuiButtonEmpty> },
        ...(!channel ? [{ field: "channel" as const, name: t("渠道"), render: (value: string) => channelName(value, catalog.find(({ id }) => id === value)?.display_name) }] : []),
        { field: "tags", name: t("标签"), render: (values: string[]) => <Tags values={values} /> },
        { field: "weight", name: t("权重"), width: "78px" },
        { field: "enabled", name: t("状态"), render: (enabled: boolean, item) => {
          const offline = !canTest(item);
          return <EuiBadge color={!enabled ? "default" : offline ? "warning" : "success"}>{!enabled ? t("停用") : offline ? t("渠道暂停") : t("启用")}</EuiBadge>;
        } },
        { name: t("操作"), render: (item: Account) => <div className="row-actions">
          <EuiButtonEmpty size="xs" disabled={!canTest(item)} onClick={() => setTesting(item)}>{t("测试")}</EuiButtonEmpty>
          <EuiButtonEmpty size="xs" color="danger" onClick={() => { action.clear(); setRemoving(item); }}>{t("删除")}</EuiButtonEmpty>
        </div> },
      ]} />
    </div> : !list.error && !list.next && <Empty title={t("还没有渠道账号")} description={available.length ? t("新增一个账号并测试发送，确认凭据与接收端正常。") : undefined} />}
    <More next={list.next} busy={list.busy} load={() => { void list.loadMore(); }} />
    {editor && <AccountEditor key={editor === "new" ? "new" : editor.id} api={api} account={editor === "new" ? undefined : editor}
      channels={editor === "new" ? available : catalog} onDone={() => { setEditor(undefined); list.reload(); }} close={() => setEditor(undefined)} />}
    {testing && <TestAccount api={api} account={testing} close={() => setTesting(undefined)} />}
    {removing && <Confirm title={t("删除账号「{name}」？", { name: removing.name })} label={t("删除账号")} busy={action.busy}
      close={() => setRemoving(undefined)} confirm={() => { void action.run(async () => {
        await api.write(`/accounts/${segment(removing.id)}`, "DELETE");
        setRemoving(undefined);
        list.reload();
      }); }}>
      <p>{t("此账号将无法接收新通知。")}</p>
      <Failure message={action.error} />
    </Confirm>}
  </>;
}

export function channelAvailable(channel?: Channel) {
  return !!channel && channel.available !== false && channel.enabled !== false;
}

export function AccountEditor({ api, account, channels, close, onDone }: {
  api: Api; account?: Account; channels: Channel[]; close: () => void; onDone: (saved: Account) => void;
}) {
  const channelName = useChannelName();
  const t = useT();
  const [name, setName] = useState(account?.name ?? "");
  const [channelId, setChannel] = useState(account?.channel ?? channels[0]?.id ?? "");
  const [tags, setTags] = useState(account?.tags.join(", ") ?? "");
  const [weight, setWeight] = useState(account?.weight ?? 1);
  const [priority, setPriority] = useState(account?.priority ?? 0);
  const [limit, setLimit] = useState<number | "">(account?.rate_limit ?? "");
  const [enabled, setEnabled] = useState(account?.enabled ?? true);
  const [replace, setReplace] = useState(false);
  const previousProxy = account?.proxy_id ?? "";
  const [proxyId, setProxyId] = useState(previousProxy);
  const [config, setConfig] = useState<JsonObject>({});
  const formId = useId();
  const advancedId = useId();
  const task = useMutation();
  const channel = channels.find((entry) => entry.id === channelId);
  const properties = channel?.config_schema.properties;
  const supportsProxy = !!properties && typeof properties === "object" && Object.hasOwn(properties, "proxy");
  const proxies = usePage<OutboundProxy>(api, supportsProxy ? "/proxies" : undefined);
  const useSharedProxy = supportsProxy && proxyId !== "";

  const save = () => task.run(async () => {
    const payload: JsonObject = { name: name.trim(), tags: split(tags), weight, priority, enabled };
    if (limit !== "" || account?.rate_limit != null) payload.rate_limit = limit === "" ? null : limit;
    if (!account) payload.channel = channelId;
    if (supportsProxy && proxyId !== previousProxy) payload.proxy_id = proxyId || null;
    if (!account || replace) {
      if (!channel) throw new Error("此渠道当前不可用。");
      payload.config = serializeConfig(channel, config, useSharedProxy);
    }
    const saved = await api.write<Account>(account ? `/accounts/${segment(account.id)}` : "/accounts", account ? "PUT" : "POST", payload);
    onDone(saved);
  });
  return <Drawer title={account ? t("编辑账号") : t("新增渠道账号")} close={close}
    footer={<><EuiButtonEmpty onClick={close}>{t("取消")}</EuiButtonEmpty><EuiButton form={formId} type="submit" fill isLoading={task.busy}>{t("保存账号")}</EuiButton></>}>
    <form id={formId} className="stack" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <Failure message={task.error} />
      <EuiFormRow label={t("账号名称")} fullWidth><EuiFieldText required fullWidth value={name} onChange={(event) => setName(event.target.value)} /></EuiFormRow>
      <EuiFormRow label={t("渠道")} fullWidth><EuiSelect fullWidth required disabled={!!account || channels.length === 1} value={channelId}
        options={channels.map(({ id, display_name }) => ({ value: id, text: channelName(id, display_name) }))}
        onChange={(event) => { setChannel(event.target.value); setConfig({}); setProxyId(""); }} /></EuiFormRow>
      {supportsProxy && <>
        <EuiFormRow label={t("代理配置")} helpText={t("未选择共享代理时，使用账号内设置的出站代理，未设置则直连。")} fullWidth>
          <EuiSelect fullWidth value={proxyId} disabled={proxies.loading}
            options={[
              { value: "", text: t("使用账号配置") },
              ...(proxyId && !proxies.items.some(({ id }) => id === proxyId) ? [{ value: proxyId, text: t("当前代理配置") }] : []),
              ...proxies.items.map(({ id, name }) => ({ value: id, text: name })),
            ]}
            onChange={(event) => setProxyId(event.target.value)} />
        </EuiFormRow>
        <Failure message={proxies.error} retry={proxies.reload} />
        {proxies.next && <EuiButtonEmpty size="xs" flush="left" isLoading={proxies.busy} onClick={() => { void proxies.loadMore(); }}>
          {t("加载更多代理配置")}
        </EuiButtonEmpty>}
      </>}
      <EuiSwitch label={t("启用账号")} checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
      <EuiAccordion id={advancedId} buttonContent={t("标签与路由")}>
        <div className="stack inset">
          <EuiFormRow label={t("标签")} fullWidth><EuiFieldText fullWidth placeholder={t("如 production, urgent")} value={tags} onChange={(event) => setTags(event.target.value)} /></EuiFormRow>
          <div className="form-grid">
            <EuiFormRow label={t("权重")} fullWidth><EuiFieldNumber fullWidth min={0} value={weight} onChange={(event) => setWeight(Number(event.target.value))} /></EuiFormRow>
            <EuiFormRow label={t("优先级")} fullWidth><EuiFieldNumber fullWidth value={priority} onChange={(event) => setPriority(Number(event.target.value))} /></EuiFormRow>
          </div>
          <EuiFormRow label={t("每分钟发送上限")} helpText={t("留空使用默认限速。")} fullWidth>
            <EuiFieldNumber fullWidth min={1} value={limit} onChange={(event) => setLimit(event.target.value === "" ? "" : event.target.valueAsNumber)} />
          </EuiFormRow>
        </div>
      </EuiAccordion>
      <EuiHorizontalRule margin="xs" />
      {account && <EuiSwitch label={t("替换渠道配置")} disabled={!channelAvailable(channel)} checked={replace} onChange={(event) => setReplace(event.target.checked)} />}
      {account && replace && <EuiText size="s" color="subdued"><p>{t("请填写整套新配置。原有凭据只在服务器端使用。")}</p></EuiText>}
      {(!account || replace) && channel && <ChannelFields value={config} channel={channel} update={setConfig} useSharedProxy={useSharedProxy} />}
    </form>
  </Drawer>;
}

function TestAccount({ api, account, close }: { api: Api; account: Account; close: () => void }) {
  const t = useT();
  const [message, setMessage] = useState({ ...blankMessage, title: t("雁字渠道测试"), body: t("这是一条测试通知。") });
  const [status, setStatus] = useState<string>();
  const task = useMutation();
  const id = useId();
  return <Drawer title={t("测试 {name}", { name: account.name })} close={close}
    footer={<EuiButton fill iconType="play" type="submit" form={id} isLoading={task.busy}>{t("发送测试通知")}</EuiButton>}>
    <form id={id} className="stack" onSubmit={(event) => {
      event.preventDefault();
      setStatus(undefined);
      void task.run(async () => {
        const result = await api.write<{ status?: string }>(`/accounts/${segment(account.id)}/test`, "POST", message);
        setStatus(result?.status === "accepted" ? "渠道已受理测试通知" : "测试通知已发送");
      });
    }}>
      <Failure message={task.error} />
      {status && <EuiCallOut color="success" iconType="check" title={t(status)} announceOnMount />}
      <Composer update={setMessage} message={message} />
    </form>
  </Drawer>;
}
