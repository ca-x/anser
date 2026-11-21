import { useId, useState } from "react";
import {
  EuiAccordion, EuiBadge, EuiBasicTable, EuiButton, EuiButtonEmpty, EuiCallOut, EuiFieldNumber,
  EuiFieldText, EuiFormRow, EuiHorizontalRule, EuiSelect, EuiSwitch, EuiText,
} from "@elastic/eui";
import { Api, segment, type Account, type Channel, type JsonObject, type Page } from "../api";
import { useMutation, usePage, useResource } from "../resources";
import { Confirm, Drawer, Empty, Failure, More, PageTitle, Progress, split, Tags } from "../components/Common";
import { blankMessage, Composer } from "../components/Composer";
import { ChannelFields, serializeConfig } from "../components/ChannelFields";

export function Accounts({ api }: { api: Api }) {
  const list = usePage<Account>(api, "/accounts");
  const channels = useResource<Page<Channel>>(api, "/channels");
  const [editor, setEditor] = useState<Account | "new">();
  const [testing, setTesting] = useState<Account>();
  const [removing, setRemoving] = useState<Account>();
  const action = useMutation();
  const runtime = useMutation();
  const [transition, setTransition] = useState<{ channel: Channel; operation: "suspend" | "reload" }>();
  const catalog = channels.data?.items ?? [];
  const available = catalog.filter((channel) => channel.available !== false);
  const changeChannel = (channel: Channel, change: { enabled?: boolean; reload?: boolean }) =>
    runtime.run(async () => {
      await api.write(`/channels/${segment(channel.id)}/runtime`, "PUT", change);
      setTransition(undefined);
      channels.reload();
    });

  return <>
    <PageTitle title="渠道账号" description="给通知渠道配置凭据、接收地址和投递权重。"
      action={<EuiButton fill iconType="plusCircle" onClick={() => setEditor("new")} disabled={available.length === 0}>新增账号</EuiButton>} />
    <Failure message={list.error ?? channels.error} retry={() => { list.reload(); channels.reload(); }} />
    {list.loading ? <Progress /> : list.items.length ? <div className="data-surface">
      <EuiBasicTable<Account> rowHeader="name" tableCaption="通知渠道账号" items={list.items} itemId="id" columns={[
        { field: "name", name: "账号", render: (value, item) =>
          <EuiButtonEmpty size="xs" flush="left" onClick={() => setEditor(item)}>{value}</EuiButtonEmpty> },
        { field: "channel", name: "渠道", render: (value: string) => available.find(({ id }) => id === value)?.display_name ?? value },
        { field: "tags", name: "标签", render: (values: string[]) => <Tags values={values} /> },
        { field: "weight", name: "权重", width: "78px" },
        { field: "enabled", name: "状态", render: (enabled: boolean, item) => {
          const offline = catalog.find(({ id }) => id === item.channel)?.available === false;
          return <EuiBadge color={!enabled ? "default" : offline ? "warning" : "success"}>{!enabled ? "停用" : offline ? "渠道暂停" : "启用"}</EuiBadge>;
        } },
        { name: "操作", render: (item: Account) => <div className="row-actions">
          <EuiButtonEmpty size="xs" onClick={() => setTesting(item)}>测试</EuiButtonEmpty>
          <EuiButtonEmpty size="xs" color="danger" onClick={() => { action.clear(); setRemoving(item); }}>删除</EuiButtonEmpty>
        </div> },
      ]} />
      <More next={list.next} busy={list.busy} load={() => { void list.loadMore(); }} />
    </div> : <Empty title="还没有渠道账号" description="新增一个账号并测试发送，确认凭据与接收端正常。" />}
    <section className="channel-catalog" aria-label="渠道运行状态">
      <h2>渠道运行状态</h2>
      {!transition && <Failure message={runtime.error} />}
      <ul>{catalog.map((channel) => <li key={channel.id}>
        <span>{channel.display_name}</span>
        <code>{channel.id}</code>
        <div className="row-actions">
          {channel.available === false
            ? <EuiButtonEmpty size="xs" disabled={runtime.busy} onClick={() => { void changeChannel(channel, { enabled: true }); }}>恢复</EuiButtonEmpty>
            : <>
                <EuiButtonEmpty size="xs" disabled={runtime.busy} onClick={() => { runtime.clear(); setTransition({ channel, operation: "suspend" }); }}>暂停</EuiButtonEmpty>
                <EuiButtonEmpty size="xs" disabled={runtime.busy} onClick={() => { runtime.clear(); setTransition({ channel, operation: "reload" }); }}>重载</EuiButtonEmpty>
              </>}
        </div>
      </li>)}</ul>
    </section>
    {transition && <Confirm title={`${transition.operation === "suspend" ? "暂停" : "重载"}「${transition.channel.display_name}」？`}
      label={transition.operation === "suspend" ? "暂停渠道" : "重载渠道"}
      busy={runtime.busy} close={() => setTransition(undefined)}
      confirm={() => { void changeChannel(transition.channel, transition.operation === "suspend" ? { enabled: false } : { reload: true }); }}>
      <p>正在执行的发送会先完成。已入队的投递保留在队列中。</p>
      <Failure message={runtime.error} />
    </Confirm>}
    {editor && <AccountEditor key={editor === "new" ? "new" : editor.id} api={api} account={editor === "new" ? undefined : editor}
      channels={editor === "new" ? available : catalog} onDone={() => { setEditor(undefined); list.reload(); }} close={() => setEditor(undefined)} />}
    {testing && <TestAccount api={api} account={testing} close={() => setTesting(undefined)} />}
    {removing && <Confirm title={`删除账号「${removing.name}」？`} label="删除账号" busy={action.busy}
      close={() => setRemoving(undefined)} confirm={() => { void action.run(async () => {
        await api.write(`/accounts/${segment(removing.id)}`, "DELETE");
        setRemoving(undefined);
        list.reload();
      }); }}>
      <p>此账号将无法接收新通知。</p>
      <Failure message={action.error} />
    </Confirm>}
  </>;
}

function AccountEditor({ api, account, channels, close, onDone }: {
  api: Api; account?: Account; channels: Channel[]; close: () => void; onDone: () => void;
}) {
  const [name, setName] = useState(account?.name ?? "");
  const [channelId, setChannel] = useState(account?.channel ?? channels[0]?.id ?? "");
  const [tags, setTags] = useState(account?.tags.join(", ") ?? "");
  const [weight, setWeight] = useState(account?.weight ?? 1);
  const [priority, setPriority] = useState(account?.priority ?? 0);
  const [limit, setLimit] = useState<number | "">(account?.rate_limit ?? "");
  const [enabled, setEnabled] = useState(account?.enabled ?? true);
  const [replace, setReplace] = useState(false);
  const [config, setConfig] = useState<JsonObject>({});
  const formId = useId();
  const advancedId = useId();
  const task = useMutation();
  const channel = channels.find((entry) => entry.id === channelId);

  const save = () => task.run(async () => {
    const payload: JsonObject = { name: name.trim(), tags: split(tags), weight, priority, enabled };
    if (limit !== "" || account?.rate_limit != null) payload.rate_limit = limit === "" ? null : limit;
    if (!account) payload.channel = channelId;
    if (!account || replace) {
      if (!channel) throw new Error("此渠道当前不可用。");
      payload.config = serializeConfig(channel, config);
    }
    await api.write(account ? `/accounts/${segment(account.id)}` : "/accounts", account ? "PUT" : "POST", payload);
    onDone();
  });
  return <Drawer title={account ? "编辑账号" : "新增渠道账号"} close={close}
    footer={<><EuiButtonEmpty onClick={close}>取消</EuiButtonEmpty><EuiButton form={formId} type="submit" fill isLoading={task.busy}>保存账号</EuiButton></>}>
    <form id={formId} className="stack" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <Failure message={task.error} />
      <EuiFormRow label="账号名称" fullWidth><EuiFieldText required fullWidth value={name} onChange={(event) => setName(event.target.value)} /></EuiFormRow>
      <EuiFormRow label="渠道" fullWidth><EuiSelect fullWidth required disabled={!!account} value={channelId}
        options={channels.map(({ id, display_name }) => ({ value: id, text: display_name }))}
        onChange={(event) => { setChannel(event.target.value); setConfig({}); }} /></EuiFormRow>
      <EuiSwitch label="启用账号" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
      <EuiAccordion id={advancedId} buttonContent="标签与路由">
        <div className="stack inset">
          <EuiFormRow label="标签" fullWidth><EuiFieldText fullWidth placeholder="如 production, urgent" value={tags} onChange={(event) => setTags(event.target.value)} /></EuiFormRow>
          <div className="form-grid">
            <EuiFormRow label="权重" fullWidth><EuiFieldNumber fullWidth min={0} value={weight} onChange={(event) => setWeight(Number(event.target.value))} /></EuiFormRow>
            <EuiFormRow label="优先级" fullWidth><EuiFieldNumber fullWidth value={priority} onChange={(event) => setPriority(Number(event.target.value))} /></EuiFormRow>
          </div>
          <EuiFormRow label="每分钟发送上限" helpText="留空使用默认限速。" fullWidth>
            <EuiFieldNumber fullWidth min={1} value={limit} onChange={(event) => setLimit(event.target.value === "" ? "" : event.target.valueAsNumber)} />
          </EuiFormRow>
        </div>
      </EuiAccordion>
      <EuiHorizontalRule margin="xs" />
      {account && <EuiSwitch label="替换渠道配置" checked={replace} onChange={(event) => setReplace(event.target.checked)} />}
      {account && replace && <EuiText size="s" color="subdued"><p>请填写整套新配置。原有凭据只在服务器端使用。</p></EuiText>}
      {(!account || replace) && channel && <ChannelFields value={config} channel={channel} update={setConfig} />}
    </form>
  </Drawer>;
}

function TestAccount({ api, account, close }: { api: Api; account: Account; close: () => void }) {
  const [message, setMessage] = useState({ ...blankMessage, title: "Anser 渠道测试", body: "这是一条测试通知。" });
  const [status, setStatus] = useState<string>();
  const task = useMutation();
  const id = useId();
  return <Drawer title={`测试 ${account.name}`} close={close}
    footer={<EuiButton fill iconType="play" type="submit" form={id} isLoading={task.busy}>发送测试通知</EuiButton>}>
    <form id={id} className="stack" onSubmit={(event) => {
      event.preventDefault();
      setStatus(undefined);
      void task.run(async () => {
        const result = await api.write<{ status?: string }>(`/accounts/${segment(account.id)}/test`, "POST", message);
        setStatus(result?.status === "accepted" ? "渠道已受理测试通知" : "测试通知已发送");
      });
    }}>
      <Failure message={task.error} />
      {status && <EuiCallOut color="success" iconType="check" title={status} announceOnMount />}
      <Composer update={setMessage} message={message} />
    </form>
  </Drawer>;
}
