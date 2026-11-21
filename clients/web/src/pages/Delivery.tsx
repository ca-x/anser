import { useEffect, useId, useRef, useState } from "react";
import {
  EuiAccordion, EuiBasicTable, EuiButton, EuiButtonEmpty, EuiCallOut, EuiFieldPassword, EuiFieldText, EuiFormRow,
  EuiLink, EuiSelect, EuiText,
} from "@elastic/eui";
import { Api, segment, type Account, type Attempt, type Channel, type Delivery as DeliveryRecord, type MessageDetail, type Page, type Publish, type Receipt, type Topic } from "../api";
import { date, Empty, Failure, JsonInput, More, object, PageTitle, Progress, split, Status, Tags } from "../components/Common";
import { blankMessage, Composer } from "../components/Composer";
import { useMutation, usePage, useResource } from "../resources";

type Navigate = (path: string) => void;

export function MessageTable({ items, navigate }: { items: MessageDetail[]; navigate: Navigate }) {
  return <EuiBasicTable<MessageDetail> rowHeader="message.title" tableCaption="消息投递记录" items={items} itemId="id" columns={[
    { field: "message.title", name: "消息", render: (_title: string, item: MessageDetail) => <EuiLink onClick={() => navigate(`/admin/messages/${segment(item.id)}`)}>
      {item.message?.title || "无标题通知"}
    </EuiLink> },
    { field: "topic", name: "主题", render: (value: string | null) => value || "直接投递" },
    { field: "status", name: "状态", render: (value: string) => <Status value={value} /> },
    { field: "created_at", name: "创建时间", render: date },
  ]} />;
}

export function Messages({ api, navigate }: { api: Api; navigate: Navigate }) {
  const list = usePage<MessageDetail>(api, "/messages");
  return <>
    <PageTitle title="投递记录" action={<EuiButton iconType="refresh" onClick={list.reload}>刷新</EuiButton>} />
    <Failure message={list.error} retry={list.reload} />
    {list.loading ? <Progress /> : list.items.length ? <div className="data-surface">
      <MessageTable items={list.items} navigate={navigate} /><More next={list.next} busy={list.busy} load={() => void list.loadMore()} />
    </div> : <Empty title="暂无投递记录" description="发出的通知会在这里显示状态和发送尝试。" action={<EuiButton onClick={() => navigate("/admin/send")}>发送通知</EuiButton>} />}
  </>;
}

export function MessageView({ api, id, navigate }: { api: Api; id: string; navigate: Navigate }) {
  const data = useResource<MessageDetail>(api, `/messages/${segment(id)}`);
  const replay = useMutation();
  const pending = data.data && (!["success", "failed", "dead", "cancelled"].includes(data.data.status)
    || data.data.deliveries?.some((entry) => ["pending", "sending", "waiting"].includes(entry.status)));
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(data.reload, 5000);
    return () => clearTimeout(timer);
  }, [pending, data.data, data.reload]);
  const detail = data.data;

  return <>
    <EuiButtonEmpty iconType="chevronSingleLeft" flush="left" size="s" onClick={() => navigate("/admin/messages")}>投递记录</EuiButtonEmpty>
    <PageTitle title={detail?.message?.title || "投递详情"} action={<>
      <EuiButton onClick={data.reload} iconType="refresh">刷新</EuiButton>
      {detail && ["failed", "dead", "cancelled"].includes(detail.status) && <EuiButton fill iconType="play" isLoading={replay.busy}
        onClick={() => void replay.run(async () => {
          const result = await api.write<Receipt>(`/messages/${segment(detail.id)}/replay`, "POST");
          navigate(`/admin/messages/${segment(result.message_id)}`);
        })}>重放通知</EuiButton>}
    </>} />
    <Failure message={data.error ?? replay.error} retry={data.error ? data.reload : undefined} />
    {data.loading && <Progress />}
    {detail && <>
      <section className="detail-intro">
        <div className="detail-meta"><Status value={detail.status} /><span>{detail.topic || "直接投递"}</span><time>{date(detail.created_at)}</time><Tags values={detail.message.tags} /></div>
        <pre className="message-body">{detail.message.body}</pre>
        <code className="message-id">{detail.id}</code>
      </section>
      <section className="stack">
        <div className="section-header"><h2>渠道投递</h2></div>
        {detail.deliveries?.length ? detail.deliveries.map((delivery) => <Delivery key={delivery.id} delivery={delivery} />)
          : <Empty title="暂无渠道尝试" description="任务进入发送阶段后，会显示具体账号和尝试结果。" />}
      </section>
    </>}
  </>;
}

function Delivery({ delivery }: { delivery: DeliveryRecord }) {
  const id = useId();
  return <article className="delivery">
    <EuiAccordion id={id} initialIsOpen={delivery.status !== "success"} buttonContent={<span className="delivery-label">
      <strong>{delivery.channel}</strong><code>{delivery.account_id}</code>
    </span>} extraAction={<Status value={delivery.status} />}>
      <div className="stack inset">
        {delivery.next_retry_at && <EuiText size="s" color="subdued"><p>下次重试 {date(delivery.next_retry_at)}</p></EuiText>}
        {delivery.attempts?.length ? <EuiBasicTable tableCaption={`${delivery.channel} 发送尝试`} items={delivery.attempts} columns={[
          { field: "n", name: "次数", width: "60px" }, { field: "started_at", name: "开始", render: date },
          { field: "latency", name: "耗时", render: (value: number | null) => value == null ? "—" : `${value} ms` },
          { name: "结果", render: (attempt: Attempt) => attempt.error_code ? <span><code>{attempt.error_code}</code> {attempt.error_msg}</span>
            : attempt.finished_at ? "成功" : "处理中" },
        ]} /> : <EuiText size="s" color="subdued"><p>暂无尝试。</p></EuiText>}
      </div>
    </EuiAccordion>
  </article>;
}

export function Send({ api, navigate }: { api: Api; navigate: Navigate }) {
  const topics = usePage<Topic>(api, "/topics");
  const channels = useResource<Page<Channel>>(api, "/channels");
  const accounts = usePage<Account>(api, "/accounts");
  const [topic, setTopic] = useState("");
  const [channel, setChannel] = useState("");
  const [account, setAccount] = useState("");
  const [message, setMessage] = useState(blankMessage);
  const [tags, setTags] = useState("");
  const [url, setUrl] = useState("");
  const [attachment, setAttachment] = useState("");
  const [callback, setCallback] = useState("");
  const [extra, setExtra] = useState("");
  const [password, setPassword] = useState("");
  const task = useMutation();
  const advanced = useId();
  const idempotency = useRef<{ body: string; token: string }>();

  return <>
    <PageTitle title="发送通知" description="发到主题，或直接选择渠道与账号。" />
    <form className="compose-form form-surface stack" onSubmit={(event) => {
      event.preventDefault(); void task.run(async () => {
        const payload: Publish = {
          ...message, title: message.title.trim(), tags: split(tags), url: url || undefined,
          attachments: attachment ? [{ url: attachment }] : undefined,
          channels: account ? [{ account_id: account }] : channel ? [{ channel }] : undefined,
          callback_url: callback || undefined, extras: extra.trim() ? object(extra) : undefined,
          topic_password: topic && password ? password : undefined,
        };
        const body = JSON.stringify({ topic, payload });
        if (idempotency.current?.body !== body) idempotency.current = { body, token: Array.from(crypto.getRandomValues(new Uint8Array(20)), (byte) => byte.toString(16).padStart(2, "0")).join("") };
        const receipt = await api.send(topic || undefined, payload, idempotency.current.token);
        navigate(`/admin/messages/${segment(receipt.message_id)}`);
      });
    }}>
      <Failure message={task.error ?? topics.error ?? channels.error ?? accounts.error} />
      <EuiFormRow label="主题" helpText="不选主题时直接投递。未指定渠道时使用对应的默认路由。" fullWidth>
        <EuiSelect fullWidth value={topic} onChange={(event) => { setTopic(event.target.value); setPassword(""); }}
          options={[{ value: "", text: "直接投递" }, ...topics.items.filter((entry) => entry.enabled).map(({ name }) => ({ value: name, text: name }))]} />
      </EuiFormRow>
      {topics.next && <EuiButtonEmpty size="xs" onClick={() => void topics.loadMore()}>加载更多主题</EuiButtonEmpty>}
      {topic && topics.items.find((item) => item.name === topic)?.protected && <EuiFormRow label="主题密码（如需要）" fullWidth>
        <EuiFieldPassword type="password" fullWidth value={password} onChange={(event) => setPassword(event.target.value)} />
      </EuiFormRow>}
      <div className="form-grid">
        <EuiFormRow label="显式渠道" fullWidth><EuiSelect fullWidth value={channel} onChange={(event) => { setChannel(event.target.value); setAccount(""); }}
          options={[{ value: "", text: "跟随策略" }, ...(channels.data?.items ?? []).map(({ id, display_name }) => ({ value: id, text: display_name }))]} /></EuiFormRow>
        <EuiFormRow label="显式账号" fullWidth><EuiSelect fullWidth value={account} onChange={(event) => setAccount(event.target.value)}
          options={[{ value: "", text: "跟随策略" }, ...accounts.items.filter((entry) => entry.enabled && (!channel || entry.channel === channel))
            .map(({ id, name }) => ({ value: id, text: name }))]} /></EuiFormRow>
      </div>
      {accounts.next && <EuiButtonEmpty size="xs" onClick={() => void accounts.loadMore()}>加载更多账号</EuiButtonEmpty>}
      <Composer message={message} update={setMessage} />
      <EuiAccordion id={advanced} buttonContent="链接、标签与投递回调">
        <div className="stack inset">
          <EuiFormRow label="消息标签" fullWidth><EuiFieldText fullWidth value={tags} onChange={(event) => setTags(event.target.value)} /></EuiFormRow>
          <EuiFormRow label="跳转链接" fullWidth><EuiFieldText fullWidth type="url" value={url} onChange={(event) => setUrl(event.target.value)} /></EuiFormRow>
          <EuiFormRow label="附件地址" fullWidth><EuiFieldText fullWidth type="url" value={attachment} onChange={(event) => setAttachment(event.target.value)} /></EuiFormRow>
          <EuiFormRow label="回调地址" fullWidth><EuiFieldText fullWidth type="url" value={callback} onChange={(event) => setCallback(event.target.value)} /></EuiFormRow>
          <JsonInput label="渠道专属参数" value={extra} set={setExtra} help="填写 JSON 对象，例如企业微信图片或飞书卡片。" />
        </div>
      </EuiAccordion>
      {topic && (channel || account) && <EuiCallOut size="s" color="warning" title="显式目标将覆盖主题默认目标。" />}
      <div className="form-actions"><EuiButton type="submit" fill iconType="play" isLoading={task.busy}>发送通知</EuiButton></div>
    </form>
  </>;
}
