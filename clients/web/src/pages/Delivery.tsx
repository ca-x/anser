import { useChannelName, useT } from "../preferences";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import {
  EuiAccordion, EuiBasicTable, EuiButton, EuiButtonEmpty, EuiButtonGroup, EuiCallOut, EuiFieldPassword, EuiFieldText, EuiFormRow,
  EuiLink, EuiSelect, EuiText, EuiTextArea,
} from "@elastic/eui";
import { Api, ApiError, errorMessage, segment, type Account, type Attempt, type Channel, type Delivery as DeliveryRecord, type MessageDetail, type NotificationTemplate, type Page, type Publish, type Receipt, type Topic, type User } from "../api";
import { RowAction, useDate, Empty, Failure, JsonInput, More, object, PageTitle, Progress, split, Status, Tags } from "../components/Common";
import { Composer } from "../components/Composer";
import { AccountEditor, channelAvailable } from "./Accounts";
import type { SendSession } from "../send-draft";
import { useMutation, usePage, useResource } from "../resources";
import { useTemplateName } from "../template-name";

type Navigate = (path: string) => void;

export function MessageTable({ items, navigate }: { items: MessageDetail[]; navigate: Navigate }) {
  const t = useT();
  const date = useDate();
  return <EuiBasicTable<MessageDetail> rowHeader="message.title" tableCaption={t("消息投递记录")} items={items} itemId="id" columns={[
    { field: "message.title", name: t("消息"), render: (_title: string, item: MessageDetail) => <EuiLink className="message-subject" href={`/admin/messages/${segment(item.id)}`} onClick={(event) => {
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      navigate(`/admin/messages/${segment(item.id)}`);
    }}>
      {item.message?.title || item.message?.body?.trim().slice(0, 120) || t("无标题通知")}
    </EuiLink> },
    { field: "topic", name: t("目的地"), render: (value: string | null, item: MessageDetail) =>
      value || (item.inbox_recipient ? t("{name} 的收件箱", { name: item.inbox_recipient }) : t("直接投递")) },
    { field: "status", name: t("状态"), render: (value: string) => <Status value={value} /> },
    { field: "created_at", name: t("创建时间"), render: date },
    { name: t("操作"), render: (item: MessageDetail) => {
      const path = `/admin/messages/${segment(item.id)}`;
      return <RowAction icon="inspect" href={path} onClick={(event) => {
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        navigate(path);
      }}>{t("查看")}</RowAction>;
    } },
  ]} />;
}

export function Messages({ api, navigate }: { api: Api; navigate: Navigate }) {
  const t = useT();
  const list = usePage<MessageDetail>(api, "/messages");
  return <>
    <PageTitle title={t("投递记录")} action={<EuiButton iconType="refresh" onClick={list.reload}>{t("刷新")}</EuiButton>} />
    <Failure message={list.error} retry={list.reload} />
    {list.loading ? <Progress /> : list.items.length ? <div className="data-surface">
      <MessageTable items={list.items} navigate={navigate} /><More next={list.next} busy={list.busy} load={() => void list.loadMore()} />
    </div> : !list.error && <Empty title={t("暂无投递记录")} description={t("发出的通知会在这里显示状态和发送尝试。")} action={<EuiButton onClick={() => navigate("/admin/send")}>{t("发送通知")}</EuiButton>} />}
  </>;
}

export function MessageView({ api, id, navigate }: { api: Api; id: string; navigate: Navigate }) {
  const t = useT();
  const date = useDate();
  const data = useResource<MessageDetail>(api, `/messages/${segment(id)}`);
  const replay = useMutation();
  const pending = data.data && (!["success", "failed", "dead", "cancelled"].includes(data.data.status)
    || data.data.deliveries?.some((entry) => ["pending", "sending", "waiting"].includes(entry.status)));
  useEffect(() => {
    if (!pending || data.fetching) return;
    const timer = setTimeout(data.reload, 5000);
    return () => clearTimeout(timer);
  }, [pending, data.data, data.error, data.fetching, data.reload]);
  const detail = data.data;

  return <>
    <EuiButtonEmpty iconType="chevronSingleLeft" flush="left" size="s" onClick={() => navigate("/admin/messages")}>{t("投递记录")}</EuiButtonEmpty>
    <PageTitle title={detail?.message?.title || t("投递详情")} action={<>
      <EuiButton onClick={data.reload} iconType="refresh">{t("刷新")}</EuiButton>
      {detail && ["failed", "dead"].includes(detail.status) && <EuiButton fill iconType="play" isLoading={replay.busy}
        onClick={() => void replay.run(async () => {
          const result = await api.write<Receipt>(`/messages/${segment(detail.id)}/replay`, "POST");
          navigate(`/admin/messages/${segment(result.message_id)}`);
        })}>{t("重放通知")}</EuiButton>}
    </>} />
    <Failure message={data.error ?? replay.error} retry={data.error ? data.reload : undefined} />
    {data.loading && <Progress />}
    {detail && <>
      <section className="detail-intro">
        <div className="detail-meta"><Status value={detail.status} /><span>{detail.topic || t("直接投递")}</span><time dateTime={new Date(detail.created_at).toISOString()}>{date(detail.created_at)}</time>{!!detail.message.tags?.length && <Tags values={detail.message.tags} />}</div>
        {detail.message.body && <pre className="message-body">{detail.message.body}</pre>}
        <code className="message-id">{detail.id}</code>
      </section>
      <section className="stack">
        <div className="section-header"><h2>{t("投递结果")}</h2></div>
        {!!detail.inbox_deliveries && <EuiCallOut size="s" color="success" iconType="checkCircleFill"
          title={detail.inbox_recipient ? t("已存入 {name} 的个人收件箱", { name: detail.inbox_recipient })
            : detail.inbox_deliveries === 1 ? t("已存入 1 个个人收件箱") : t("已存入 {count} 个个人收件箱", { count: detail.inbox_deliveries })} />}
        {detail.deliveries?.length ? detail.deliveries.map((delivery) => <Delivery key={delivery.id} delivery={delivery} />)
          : !detail.inbox_deliveries && <Empty title={t("暂无渠道尝试")} description={pending ? t("任务进入发送阶段后，会显示具体账号和尝试结果。") : undefined} />}
      </section>
    </>}
  </>;
}

function Delivery({ delivery }: { delivery: DeliveryRecord }) {
  const channelName = useChannelName();
  const t = useT();
  const date = useDate();
  const id = useId();
  return <article className="delivery">
    <EuiAccordion id={id} initialIsOpen={delivery.status !== "success"} buttonContent={<span className="delivery-label">
      <strong>{delivery.account_name || channelName(delivery.channel)}</strong>
      {delivery.account_name ? <span>{channelName(delivery.channel)}</span> : <code>{delivery.account_id}</code>}
    </span>} extraAction={<Status value={delivery.status === "pending" && delivery.next_retry_at != null ? "waiting" : delivery.status} />}>
      <div className="stack inset">
        {delivery.account_name && <EuiText size="s" color="subdued"><p>{t("账号 ID")} <code>{delivery.account_id}</code></p></EuiText>}
        {delivery.next_retry_at && <EuiText size="s" color="subdued"><p>{t("下次重试 {time}", { time: date(delivery.next_retry_at) })}</p></EuiText>}
        {delivery.attempts?.length ? <EuiBasicTable tableCaption={t("{channel} 发送尝试", { channel: channelName(delivery.channel) })} items={delivery.attempts} columns={[
          { field: "n", name: t("次数"), width: "60px" }, { field: "started_at", name: t("开始"), render: date },
          { field: "latency", name: t("耗时"), render: (value: number | null) => value == null ? "—" : `${value} ms` },
          { name: t("结果"), render: (attempt: Attempt) => attempt.error_code ? <span><code>{attempt.error_code}</code> {attempt.error_msg}</span>
            : attempt.finished_at ? t("成功") : t("处理中") },
        ]} /> : <EuiText size="s" color="subdued"><p>{t("暂无尝试。")}</p></EuiText>}
      </div>
    </EuiAccordion>
  </article>;
}

function withSelection(value: string, label: string, options: { value: string; text: string }[]) {
  if (!value || options.some((option) => option.value === value)) return options;
  return [...options, { value, text: label, disabled: true }];
}

export function Send({ api, session, navigate }: { api: Api; session: SendSession; navigate: Navigate }) {
  const channelName = useChannelName();
  const t = useT();
  const topics = usePage<Topic>(api, "/topics");
  const channels = useResource<Page<Channel>>(api, "/channels");
  const accounts = usePage<Account>(api, "/accounts");
  const { draft, busy, receipt, error } = useSyncExternalStore(session.subscribe, session.snapshot);
  const { inbox, recipient, topic, channel, account, message, tags, url, attachment, callback, extra,
    templateEnabled, templateId, templateVariables } = draft;
  const templateName = useTemplateName();
  const sourceControl = useId();
  const useTemplate = !inbox && templateEnabled;
  const templates = usePage<NotificationTemplate>(api, useTemplate ? "/templates" : undefined);
  const listedTemplate = templates.items.find((item) => item.id === templateId);
  const templatePath = useTemplate && templateId && !templates.loading && !listedTemplate ? `/templates/${segment(templateId)}` : undefined;
  const templateLookup = useResource<NotificationTemplate>(api, templatePath);
  const selectedTemplate = listedTemplate ?? (templateLookup.path === templatePath && !templateLookup.error ? templateLookup.data : undefined);
  const reloadTemplates = () => { templates.reload(); templateLookup.reload(); };
  const refreshTemplate = useTemplate && error instanceof ApiError
    && ["template_not_found", "invalid_template_variables"].includes(error.code ?? "");
  const visibleTemplates = selectedTemplate && !listedTemplate ? [...templates.items, selectedTemplate] : templates.items;
  const templateError = templates.error ?? (templatePath && templateLookup.path === templatePath ? templateLookup.error : undefined);
  const sourceManual = `${sourceControl}-manual`;
  const sourceTemplate = `${sourceControl}-template`;
  const users = usePage<User>(api, inbox ? "/users" : undefined);
  const usernames = useId();
  const [password, setPassword] = useState("");
  const [adding, setAdding] = useState(false);
  const task = useMutation();
  const advanced = useId();
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const listedTopic = topics.items.find((item) => item.name === topic);
  const topicPath = topic && !topics.loading && !listedTopic ? `/topics/${segment(topic)}` : undefined;
  const topicLookup = useResource<Topic>(api, topicPath);
  const selectedTopic = listedTopic ?? (topicLookup.path === topicPath ? topicLookup.data : undefined);
  const listedAccount = accounts.items.find((item) => item.id === account);
  const accountPath = account && !accounts.loading && !listedAccount ? `/accounts/${segment(account)}` : undefined;
  const accountLookup = useResource<Account>(api, accountPath);
  const selectedAccount = listedAccount ?? (accountLookup.path === accountPath ? accountLookup.data : undefined);

  const catalog = (channels.data?.items ?? []).filter(channelAvailable);
  const channelIds = new Set(catalog.map((item) => item.id));
  const knownAccounts = selectedAccount && !listedAccount ? [...accounts.items, selectedAccount] : accounts.items;
  const availableAccounts = knownAccounts.filter((item) => item.enabled && channelIds.has(item.channel));
  const accountsComplete = !!channels.data && !channels.error && !accounts.loading && !accounts.error && !accounts.next;
  const availableChannels = catalog.filter((item) => !accountsComplete || availableAccounts.some((entry) => entry.channel === item.id));
  const choices = availableAccounts.filter((item) => !channel || item.channel === channel);
  const availableTopics = topics.items.filter((item) => item.enabled);
  if (selectedTopic?.enabled && !listedTopic) availableTopics.push(selectedTopic);
  const resolvingAccount = !!accountPath && (accountLookup.path !== accountPath || accountLookup.loading);
  const resolvingTopic = !!topicPath && (topicLookup.path !== topicPath || topicLookup.loading);
  const noExternalTarget = accountsComplete && !availableAccounts.length && !resolvingAccount;
  const invalidTarget = (!!account && !choices.some((item) => item.id === account)) ||
    (!!channel && !availableChannels.some((item) => item.id === channel)) || (!!topic && !selectedTopic?.enabled);
  const blocked = inbox ? !recipient.trim() : invalidTarget || (!topic && noExternalTarget) || (useTemplate && !selectedTemplate);
  const resourceError = inbox ? users.error : topics.error ?? channels.error ?? accounts.error
    ?? (accountPath && accountLookup.path === accountPath ? accountLookup.error : undefined)
    ?? (topicPath && topicLookup.path === topicPath ? topicLookup.error : undefined);
  const destination = inbox ? "inbox" : topic ? `topic:${topic}` : "channels";

  return <>
    <PageTitle title={t("发送通知")} />
    <form className="compose-form form-surface stack" onSubmit={(event) => {
      event.preventDefault();
      if (blocked || busy) return;
      void task.run(async () => {
        const manual = { title: message.title.trim(), body: message.body, format: message.format };
        let result: Receipt | undefined;
        if (inbox) {
          const username = recipient.trim();
          result = await session.submit(JSON.stringify({ recipient: username, payload: manual }), (key) => api.sendInbox(username, manual, key));
        } else {
          const payload: Publish = useTemplate && selectedTemplate ? {
            template_id: selectedTemplate.id,
            variables: Object.fromEntries(selectedTemplate.variables.map((name) => [
              name, Object.hasOwn(templateVariables, name) ? templateVariables[name] : "",
            ])),
          } : manual;
          payload.tags = split(tags);
          payload.url = url || undefined;
          payload.attachments = attachment ? [{ url: attachment }] : undefined;
          payload.channels = account ? [{ account_id: account }] : channel ? [{ channel }] : undefined;
          payload.callback_url = callback || undefined;
          payload.extras = extra.trim() ? object(extra) : undefined;
          result = await session.submit(JSON.stringify({ topic, payload }), (key) => api.send(topic || undefined,
            { ...payload, topic_password: topic && password ? password : undefined }, key));
        }
        if (result && mounted.current) {
          session.acknowledgeReceipt();
          navigate(`/admin/messages/${segment(result.message_id)}`);
        }
      });
    }}>
      <Failure message={task.error ?? (error ? errorMessage(error) : undefined)} retry={refreshTemplate ? reloadTemplates : undefined} />
      <Failure message={resourceError} retry={() => {
        if (inbox) users.reload();
        else { accounts.reload(); topics.reload(); channels.reload(); accountLookup.reload(); topicLookup.reload(); }
      }} />
      {receipt && <EuiCallOut size="s" color="success" title={t("上次通知已提交")}>
        <EuiButtonEmpty size="xs" flush="left" onClick={() => { session.acknowledgeReceipt(); navigate(`/admin/messages/${segment(receipt.message_id)}`); }}>{t("查看投递结果")}</EuiButtonEmpty>
      </EuiCallOut>}
      <EuiFormRow label={t("发送到")} fullWidth>
        <EuiSelect fullWidth value={destination} onChange={(event) => {
          const value = event.target.value;
          session.edit({ inbox: value === "inbox", topic: value.startsWith("topic:") ? value.slice(6) : "" });
          setPassword("");
          task.clear();
        }} options={withSelection(destination, topic, [
          { value: "channels", text: t("渠道账号") }, { value: "inbox", text: t("个人收件箱") },
          ...availableTopics.map(({ name }) => ({ value: `topic:${name}`, text: t("主题 · {name}", { name }) })),
        ])} />
      </EuiFormRow>
      {inbox && <>
        <EuiFormRow label={t("收件用户名")} helpText={t("输入此服务器上的用户名，也可以发给自己。")} fullWidth>
          <EuiFieldText required fullWidth autoComplete="off" autoCapitalize="none" spellCheck={false} list={usernames}
            value={recipient} onChange={(event) => session.edit({ recipient: event.target.value })} />
        </EuiFormRow>
        <datalist id={usernames}>{users.items.filter((user) => user.enabled).map((user) => <option key={user.id} value={user.username} />)}</datalist>
        {users.next && <EuiButtonEmpty size="xs" onClick={() => void users.loadMore()}>{t("加载更多用户")}</EuiButtonEmpty>}
      </>}
      {!inbox && <>
        {topics.next && <EuiButtonEmpty size="xs" onClick={() => void topics.loadMore()}>{t("加载更多主题")}</EuiButtonEmpty>}
        {selectedTopic?.protected && <EuiFormRow label={t("主题密码（如需要）")} fullWidth>
          <EuiFieldPassword type="password" fullWidth value={password} onChange={(event) => setPassword(event.target.value)} />
        </EuiFormRow>}
        <div className="form-grid">
          <EuiFormRow label={t("渠道")} fullWidth><EuiSelect fullWidth value={channel} onChange={(event) => session.edit({ channel: event.target.value, account: "" })}
            options={withSelection(channel, channelName(channel), [{ value: "", text: t("跟随策略") }, ...availableChannels.map(({ id, display_name }) => ({ value: id, text: channelName(id, display_name) }))])} /></EuiFormRow>
          <EuiFormRow label={t("账号")} fullWidth><EuiSelect fullWidth value={account} onChange={(event) => session.edit({ account: event.target.value })}
            options={withSelection(account, selectedAccount?.name ?? account, [{ value: "", text: t("跟随策略") }, ...choices.map(({ id, name }) => ({ value: id, text: name }))])} /></EuiFormRow>
        </div>
        {accounts.next && <EuiButtonEmpty size="xs" onClick={() => void accounts.loadMore()}>{t("加载更多账号")}</EuiButtonEmpty>}
        {!topic && noExternalTarget && <EuiCallOut size="s" iconType="iInCircle" title={t(knownAccounts.length ? "渠道账号当前不可用" : "添加第一个接收账号")}>
          <p>{t("添加账号即可通过渠道发送，也可以直接发到个人收件箱。")}</p>
          <div className="row-actions">
            <EuiButtonEmpty flush="left" size="s" onClick={() => { session.edit({ inbox: true, topic: "" }); setPassword(""); task.clear(); }}>{t("发到个人收件箱")}</EuiButtonEmpty>
            {!!catalog.length && <EuiButtonEmpty flush="left" size="s" onClick={() => setAdding(true)}>{t("新增渠道账号")}</EuiButtonEmpty>}
            {!!knownAccounts.length && <EuiButtonEmpty size="s" onClick={() => navigate("/admin/accounts")}>{t("管理账号")}</EuiButtonEmpty>}
            {!catalog.length && <EuiButtonEmpty flush="left" size="s" onClick={() => navigate("/admin/channels")}>{t("管理渠道插件")}</EuiButtonEmpty>}
          </div>
        </EuiCallOut>}
        {invalidTarget && !topics.loading && !accounts.loading && !channels.loading && !resolvingAccount && !resolvingTopic &&
          <EuiCallOut size="s" color="warning" title={t("所选目标已不可用，请重新选择。")} />}
      </>}
      {!inbox && <EuiFormRow label={t("消息来源")} fullWidth>
        <EuiButtonGroup legend={t("消息来源")} buttonSize="s" isFullWidth
          options={[{ id: sourceManual, label: t("手写内容") }, { id: sourceTemplate, label: t("套用模板") }]}
          idSelected={useTemplate ? sourceTemplate : sourceManual}
          onChange={(id) => { session.edit({ templateEnabled: id === sourceTemplate }); task.clear(); }} />
      </EuiFormRow>}
      {useTemplate ? <>
        <EuiFormRow label={t("选择模板")} fullWidth>
          <EuiSelect fullWidth value={templateId} isLoading={templates.loading}
            options={withSelection(templateId, templateId, [{ value: "", text: t("请选择") },
              ...visibleTemplates.map((item) => ({
                value: item.id,
                text: item.builtin ? templateName(item) : t("{name}（{visibility}）", {
                  name: templateName(item), visibility: t(item.shared ? "共享" : "仅自己"),
                }),
              })),
            ])}
            onChange={(event) => {
              session.edit({ templateId: event.target.value, templateVariables: {} });
              task.clear();
            }} />
        </EuiFormRow>
        <div className="row-actions">
          <EuiButtonEmpty size="xs" flush="left" onClick={() => navigate("/admin/templates")}>{t("管理模板")}</EuiButtonEmpty>
          {templates.next && <EuiButtonEmpty size="xs" isLoading={templates.busy}
            onClick={() => void templates.loadMore()}>{t("加载更多模板")}</EuiButtonEmpty>}
        </div>
        <Failure message={templateError} retry={reloadTemplates} />
        {!!selectedTemplate?.variables.length && <fieldset className="target-row stack">
          <legend>{t("模板变量")}</legend>
          {selectedTemplate.variables.map((name) => <EuiFormRow key={name} label={name} fullWidth>
            <EuiTextArea fullWidth rows={2} value={Object.hasOwn(templateVariables, name) ? templateVariables[name] : ""}
              onChange={(event) => session.edit({ templateVariables: { ...templateVariables, [name]: event.target.value } })} />
          </EuiFormRow>)}
        </fieldset>}
      </> : <Composer message={message} update={(message) => session.edit({ message })} />}
      {!inbox && <EuiAccordion id={advanced} initialIsOpen={!!(tags || url || attachment || callback || extra)} buttonContent={t("链接、标签与投递回调")}>
        <div className="stack inset">
          <EuiFormRow label={t("消息标签")} fullWidth><EuiFieldText fullWidth value={tags} onChange={(event) => session.edit({ tags: event.target.value })} /></EuiFormRow>
          <EuiFormRow label={t("跳转链接")} fullWidth><EuiFieldText fullWidth type="url" value={url} onChange={(event) => session.edit({ url: event.target.value })} /></EuiFormRow>
          <EuiFormRow label={t("附件地址")} fullWidth><EuiFieldText fullWidth type="url" value={attachment} onChange={(event) => session.edit({ attachment: event.target.value })} /></EuiFormRow>
          <EuiFormRow label={t("回调地址")} fullWidth><EuiFieldText fullWidth type="url" value={callback} onChange={(event) => session.edit({ callback: event.target.value })} /></EuiFormRow>
          <JsonInput label={t("渠道专属参数")} value={extra} set={(extra) => session.edit({ extra })} help={t("填写 JSON 对象，例如企业微信图片或飞书卡片。")} />
        </div>
      </EuiAccordion>}
      {!inbox && topic && (channel || account) && <EuiCallOut size="s" color="warning" title={t("显式目标将覆盖主题默认目标。")} />}
      <div className="form-actions"><EuiButton type="submit" fill iconType="play" disabled={blocked} isLoading={busy}>{t("发送通知")}</EuiButton></div>
    </form>
    {adding && <AccountEditor api={api} channels={catalog} close={() => setAdding(false)} onDone={(created) => {
      if (created.enabled) session.edit({ channel: created.channel, account: created.id });
      setAdding(false);
      accounts.reload();
    }} />}
  </>;
}
