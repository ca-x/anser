import { useT } from "../preferences";
import { useId, useState } from "react";
import {
  EuiBadge, EuiBasicTable, EuiButton, EuiButtonEmpty, EuiFieldNumber, EuiFieldPassword, EuiFieldText,
  EuiFormRow, EuiSelect, EuiSwitch, EuiText, EuiTextArea,
} from "@elastic/eui";
import { Api, segment, type Account, type Channel, type JsonObject, type Page, type Policy, type Subscription, type Topic } from "../api";
import { baselinePolicy, modes, PolicyFields } from "../components/PolicyFields";
import { RowAction, Confirm, useDate, Drawer, Empty, Failure, JsonInput, More, object, PageTitle, Progress, split, Tags } from "../components/Common";
import { LazycatDeviceField, useDeviceDirectory } from "../components/LazycatDeviceField";
import { serializeDeviceTarget, type DeviceTarget } from "../form-values";
import { useMutation, usePage, useResource } from "../resources";

export function Topics({ api }: { api: Api }) {
  const t = useT();
  const topics = usePage<Topic>(api, "/topics");
  const accounts = usePage<Account>(api, "/accounts");
  const channels = useResource<Page<Channel>>(api, "/channels");
  const [editor, setEditor] = useState<Topic | "new">();
  const [subscribers, setSubscribers] = useState<Topic>();
  const [removing, setRemoving] = useState<Topic>();
  const remove = useMutation();

  return <>
    <PageTitle title={t("主题与订阅")} description={t("为通知定义分发策略，管理独立的订阅目标。")}
      action={<EuiButton fill iconType="plusCircle" onClick={() => setEditor("new")}>{t("新建主题")}</EuiButton>} />
    <Failure message={topics.error} retry={topics.reload} />
    {topics.loading ? <Progress /> : topics.items.length ? <div className="data-surface">
      <EuiBasicTable<Topic> rowHeader="name" tableCaption={t("通知主题")} items={topics.items} itemId="name" columns={[
        { field: "name", name: t("主题"), render: (name, topic) =>
          <EuiButtonEmpty size="xs" flush="left" onClick={() => setEditor(topic)}>{name}</EuiButtonEmpty> },
        { field: "description", name: t("说明"), truncateText: true },
        { field: "policy", name: t("路由"), render: (policy: Policy) => t(modes.find(({ value }) => value === policy.mode)?.text ?? policy.mode) },
        { name: t("状态"), render: (topic: Topic) => <div className="tags">
          <EuiBadge color={topic.enabled ? "success" : "default"}>{topic.enabled ? t("启用") : t("停用")}</EuiBadge>
          {topic.protected && <EuiBadge iconType="lock">{t("需要密码")}</EuiBadge>}
        </div> },
        { name: t("操作"), render: (topic: Topic) => <div className="row-actions">
          <RowAction icon="pencil" onClick={() => setEditor(topic)}>{t("编辑")}</RowAction>
          <RowAction icon="users" onClick={() => setSubscribers(topic)}>{t("订阅")}</RowAction>
          <RowAction icon="trash" danger onClick={() => { remove.clear(); setRemoving(topic); }}>{t("删除")}</RowAction>
        </div> },
      ]} />
      <More next={topics.next} busy={topics.busy} load={() => void topics.loadMore()} />
    </div> : !topics.error && <Empty title={t("还没有主题")} description={t("创建主题，把同一类通知发给相应订阅者。")} />}
    {editor && <TopicEditor api={api} topic={editor === "new" ? undefined : editor} accounts={accounts.items}
      channels={channels.data?.items ?? []} close={() => setEditor(undefined)} onDone={() => { setEditor(undefined); topics.reload(); }}
      moreAccounts={accounts.next ? () => void accounts.loadMore() : undefined} />}
    {subscribers && <Subscriptions api={api} topic={subscribers} accounts={accounts.items} close={() => setSubscribers(undefined)}
      moreAccounts={accounts.next ? () => void accounts.loadMore() : undefined} />}
    {removing && <Confirm title={t("删除主题「{name}」？", { name: removing.name })} label={t("删除主题")} busy={remove.busy}
      close={() => setRemoving(undefined)} confirm={() => void remove.run(async () => {
        await api.write(`/topics/${segment(removing.name)}`, "DELETE");
        setRemoving(undefined); topics.reload();
      })}>
      <p>{t("主题的订阅将一并删除。")}</p><Failure message={remove.error} />
    </Confirm>}
  </>;
}

function TopicEditor({ api, topic, channels, accounts, close, onDone, moreAccounts }: {
  api: Api; topic?: Topic; channels: Channel[]; accounts: Account[];
  close: () => void; onDone: () => void; moreAccounts?: () => void;
}) {
  const t = useT();
  const id = useId();
  const [name, setName] = useState(topic?.name ?? "");
  const [description, setDescription] = useState(topic?.description ?? "");
  const [enabled, setEnabled] = useState(topic?.enabled ?? true);
  const [tags, setTags] = useState(topic?.default_tags?.join(", ") ?? "");
  const [retention, setRetention] = useState<number | "">(topic?.retention ?? "");
  const [policy, setPolicy] = useState(topic?.policy ?? baselinePolicy);
  const [passwordMode, setPasswordMode] = useState("keep");
  const [password, setPassword] = useState("");
  const task = useMutation();

  return <Drawer title={topic ? t("编辑主题 {name}", { name: topic.name }) : t("新建主题")} close={close}
    footer={<><EuiButtonEmpty onClick={close}>{t("取消")}</EuiButtonEmpty><EuiButton type="submit" form={id} fill isLoading={task.busy}>{t("保存主题")}</EuiButton></>}>
    <form id={id} className="stack" onSubmit={(event) => {
      event.preventDefault(); void task.run(async () => {
        const payload: JsonObject = { name: name.trim(), description, enabled, default_tags: split(tags), retention: retention === "" ? null : retention, policy };
        if (passwordMode === "set") payload.password = password;
        if (passwordMode === "remove") payload.password = null;
        await api.write(topic ? `/topics/${segment(topic.name)}` : "/topics", topic ? "PUT" : "POST", payload);
        onDone();
      });
    }}>
      <Failure message={task.error} />
      <EuiFormRow label={t("主题名称")} fullWidth>
        <EuiFieldText required fullWidth pattern="[a-zA-Z0-9._\-]+" maxLength={128} value={name} onChange={(event) => setName(event.target.value)} />
      </EuiFormRow>
      <EuiFormRow label={t("说明")} fullWidth><EuiTextArea fullWidth rows={3} value={description} onChange={(event) => setDescription(event.target.value)} /></EuiFormRow>
      <EuiSwitch label={t("启用主题")} checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
      <div className="form-grid">
        <EuiFormRow label={t("默认标签")} fullWidth><EuiFieldText fullWidth value={tags} onChange={(event) => setTags(event.target.value)} /></EuiFormRow>
        <EuiFormRow label={t("投递记录保留天数")} fullWidth><EuiFieldNumber fullWidth min={1} value={retention}
          onChange={(event) => setRetention(event.target.value === "" ? "" : event.target.valueAsNumber)} /></EuiFormRow>
      </div>
      <EuiFormRow label={t("主题密码")} fullWidth>
        <EuiSelect fullWidth value={passwordMode}
          options={[{ value: "keep", text: topic?.protected ? t("保留现有密码") : t("无密码") }, { value: "set", text: t("设置密码") },
            ...(topic?.protected ? [{ value: "remove", text: t("清除密码") }] : [])]} onChange={(event) => setPasswordMode(event.target.value)} />
      </EuiFormRow>
      {passwordMode === "set" && <EuiFormRow label={t("新密码")} fullWidth>
        <EuiFieldPassword type="password" autoComplete="new-password" required fullWidth value={password} onChange={(event) => setPassword(event.target.value)} />
      </EuiFormRow>}
      <PolicyFields value={policy} update={setPolicy} accounts={accounts} channels={channels} />
      {moreAccounts && <EuiButtonEmpty size="xs" onClick={moreAccounts}>{t("加载更多可选账号")}</EuiButtonEmpty>}
    </form>
  </Drawer>;
}

function Subscriptions({ api, topic, accounts, close, moreAccounts }: {
  api: Api; topic: Topic; accounts: Account[]; close: () => void; moreAccounts?: () => void;
}) {
  const t = useT();
  const date = useDate();
  const path = `/topics/${segment(topic.name)}/subscriptions`;
  const list = usePage<Subscription>(api, path);
  const [showForm, setShowForm] = useState(false);
  const [removing, setRemoving] = useState<Subscription>();
  const [reference, setReference] = useState("");
  const [account, setAccount] = useState("");
  const [filter, setFilter] = useState("");
  const [target, setTarget] = useState("");
  const [device, setDevice] = useState<DeviceTarget>();
  const selectedAccount = accounts.find((item) => item.id === account);
  const lazycat = selectedAccount?.channel === "lazycat";
  const devices = useDeviceDirectory(api, showForm && lazycat);
  const targetReady = (!account || !!selectedAccount) && (!lazycat || !device || devices.accepts(device));
  const [password, setPassword] = useState("");
  const task = useMutation();
  const remove = useMutation();

  return <>
    <Drawer title={t("订阅 · {name}", { name: topic.name })} close={close} size="l"
      footer={<EuiButton fill iconType="plusCircle" onClick={() => setShowForm((value) => !value)}>{showForm ? t("收起表单") : t("添加订阅")}</EuiButton>}>
      <div className="stack">
        <Failure message={list.error} retry={list.reload} />
        {showForm && <form className="stack form-surface" onSubmit={(event) => {
          event.preventDefault();
          if (!targetReady) return;
          void task.run(async () => {
            await api.write(path, "POST", {
              subscriber_ref: reference.trim(), account_id: account || undefined,
              filter: split(filter), target: lazycat ? serializeDeviceTarget(device) : account && target.trim() ? object(target) : undefined,
              password: password || undefined,
            });
            setReference(""); setAccount(""); setFilter(""); setTarget(""); setDevice(undefined); setPassword(""); setShowForm(false);
            list.reload();
          });
        }}>
          <Failure message={task.error} />
          <EuiFormRow label={t("订阅者标识")} fullWidth><EuiFieldText required fullWidth value={reference} onChange={(event) => setReference(event.target.value)} /></EuiFormRow>
          <EuiFormRow label={t("专属渠道账号")} fullWidth><EuiSelect fullWidth value={account}
            options={[{ value: "", text: t("使用主题路由") }, ...(account && !selectedAccount ? [{ value: account, text: account, disabled: true }] : []), ...accounts.map(({ id, name }) => ({ value: id, text: name }))]}
            onChange={(event) => { setAccount(event.target.value); setTarget(""); setDevice(undefined); task.clear(); }} /></EuiFormRow>
          {moreAccounts && <EuiButtonEmpty size="xs" onClick={moreAccounts}>{t("加载更多可选账号")}</EuiButtonEmpty>}
          <EuiFormRow label={t("消息标签过滤")} fullWidth><EuiFieldText fullWidth value={filter} placeholder={t("逗号分隔")} onChange={(event) => setFilter(event.target.value)} /></EuiFormRow>
          {lazycat && <LazycatDeviceField state={devices} target={device} optionalLabel={t("使用账号设备")} inherited choose={setDevice} />}
          {selectedAccount && !lazycat && <JsonInput label={t("账号接收目标覆盖")} value={target} set={setTarget} help={t("可选 JSON 对象，例如 Telegram 的 chat_id。")} />}
          {topic.protected && <EuiFormRow label={t("主题密码（如需要）")} fullWidth><EuiFieldPassword type="password" fullWidth value={password}
            onChange={(event) => setPassword(event.target.value)} /></EuiFormRow>}
          <EuiButton type="submit" fill disabled={!targetReady} isLoading={task.busy}>{t("保存订阅")}</EuiButton>
        </form>}
        {list.loading ? <Progress /> : list.items.length ? <EuiBasicTable<Subscription> rowHeader="subscriber_ref" tableCaption={t("主题订阅")} items={list.items} itemId="id" columns={[
          { field: "subscriber_ref", name: t("订阅者") },
          { field: "account_id", name: t("账号"), render: (id: string | null) => accounts.find((entry) => entry.id === id)?.name ?? id ?? t("主题路由") },
          { field: "filter", name: t("过滤标签"), render: (values: string[]) => <Tags values={values} /> },
          { field: "created_at", name: t("建立时间"), render: date },
          { name: t("操作"), render: (item: Subscription) => <RowAction icon="trash" danger onClick={() => { remove.clear(); setRemoving(item); }}>{t("退订")}</RowAction> },
        ]} /> : !list.error && <Empty title={t("还没有订阅")} description={t("添加接收人并按需要设置消息标签过滤。")} />}
        <More next={list.next} busy={list.busy} load={() => void list.loadMore()} />
      </div>
    </Drawer>
    {removing && <Confirm title={t("退订「{name}」？", { name: removing.subscriber_ref })} label={t("确认退订")} busy={remove.busy}
      close={() => setRemoving(undefined)} confirm={() => void remove.run(async () => {
        await api.write(`${path}/${segment(removing.id)}`, "DELETE");
        setRemoving(undefined); list.reload();
      })}>
      <EuiText><p>{t("待发送和等待重试的相关投递也会取消。")}</p></EuiText>
      <Failure message={remove.error} />
    </Confirm>}
  </>;
}
