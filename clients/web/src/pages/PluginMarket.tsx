import { useId, useState } from "react";
import {
  EuiBadge, EuiBasicTable, EuiButton, EuiButtonEmpty, EuiCallOut, EuiFieldText,
  EuiFormRow, EuiLink, EuiSelect, EuiText, EuiTextArea,
} from "@elastic/eui";
import { Api, segment, type Topic } from "../api";
import { Drawer, Empty, Failure, More, PageTitle, Progress, useDate } from "../components/Common";
import { useT } from "../preferences";
import { useMutation, usePage } from "../resources";

const kinds = {
  channel: "通知渠道",
  task: "任务",
  content_transform: "内容转换",
} as const;

type Kind = keyof typeof kinds;
type Manifest = {
  id: string;
  kind: Kind;
  version: string;
  name: string;
  description: string;
  source_url: string;
  sha256?: string;
};
type Listing = { message_id: string; created_at: number; manifest: Manifest };

function listingsPath(topic: string) {
  return `/topics/${segment(topic)}/plugin-listings`;
}

export default function PluginMarket({ api, navigate }: { api: Api; navigate: (path: string) => void }) {
  const t = useT();
  const topics = usePage<Topic>(api, "/topics");
  const [selected, select] = useState("");
  const topic = topics.items.find(({ name }) => name === selected);

  return <>
    <PageTitle title={t("插件市场")} description={t("通过主题分享插件版本和源码。主题订阅者可以收到发布通知。")}
      action={<EuiButtonEmpty size="s" iconType="arrowLeft" onClick={() => navigate("/admin/topics")}>{t("返回主题")}</EuiButtonEmpty>} />
    <Failure message={topics.error} retry={topics.reload} />
    {topics.loading ? <Progress /> : topics.items.length ? <>
      <div className="form-grid">
        <EuiFormRow label={t("目录主题")} fullWidth>
          <EuiSelect fullWidth value={selected} onChange={(event) => select(event.target.value)}
            options={[{ value: "", text: t("选择主题") }, ...topics.items.map(({ name }) => ({ value: name, text: name }))]} />
        </EuiFormRow>
      </div>
      <More next={topics.next} busy={topics.busy} load={() => void topics.loadMore()} />
      {topic ? <Catalog key={topic.name} api={api} topic={topic} /> : <Empty title={t("选择主题以查看插件")} />}
    </> : !topics.error && <Empty title={t("还没有目录主题")} description={t("创建一个主题，然后返回这里发布第一条插件条目。")}
      action={<EuiButton onClick={() => navigate("/admin/topics")}>{t("管理主题")}</EuiButton>} />}
  </>;
}

function Catalog({ api, topic }: { api: Api; topic: Topic }) {
  const t = useT();
  const [kind, setKind] = useState<Kind | "">("");
  const [editor, setEditor] = useState(false);
  const [published, setPublished] = useState(false);
  const [revision, refresh] = useState(0);

  return <section className="stack" aria-label={t("插件条目")}>
    <div className="section-header">
      <h2>{t("插件条目")}</h2>
      {topic.enabled && <EuiButton size="s" fill iconType="plusCircle" onClick={() => setEditor(true)}>{t("发布插件条目")}</EuiButton>}
    </div>
    {!topic.enabled && <EuiCallOut size="s" title={t("启用主题后即可发布插件条目。")} />}
    {published && <EuiCallOut announceOnMount size="s" color="success" title={t("插件条目已发布。")} />}
    <div className="form-grid">
      <EuiFormRow label={t("插件类型")} fullWidth>
        <EuiSelect fullWidth value={kind} onChange={(event) => setKind(event.target.value as Kind | "")}
          options={[{ value: "", text: t("全部类型") }, ...Object.entries(kinds).map(([value, label]) => ({ value, text: t(label) }))]} />
      </EuiFormRow>
    </div>
    <Listings key={`${kind}:${revision}`} api={api} topic={topic.name} kind={kind} />
    {editor && <PublishListing api={api} topic={topic.name} close={() => setEditor(false)} done={(nextKind) => {
      if (kind && kind !== nextKind) setKind(nextKind);
      setPublished(true); setEditor(false); refresh((value) => value + 1);
    }} />}
  </section>;
}

function Listings({ api, topic, kind }: { api: Api; topic: string; kind: Kind | "" }) {
  const t = useT();
  const date = useDate();
  const [details, setDetails] = useState<Listing>();
  const results = usePage<Listing>(api, listingsPath(topic) + (kind ? `?kind=${segment(kind)}` : ""));
  return <>
    <Failure message={results.error} retry={results.reload} />
    {results.loading ? <Progress /> : results.items.length ? <div className="data-surface">
      <EuiBasicTable<Listing> tableCaption={t("插件条目")} items={results.items} itemId="message_id" rowHeader="manifest"
        columns={[
          { field: "manifest", name: t("名称"), render: (manifest: Manifest, item) =>
            <EuiButtonEmpty size="xs" flush="left" onClick={() => setDetails(item)}>{manifest.name}</EuiButtonEmpty> },
          { field: "manifest.kind", name: t("插件类型"), render: (kind: Kind) => <EuiBadge>{t(kinds[kind])}</EuiBadge> },
          { field: "manifest.version", name: t("版本") },
          { field: "created_at", name: t("发布时间"), render: date },
          { field: "manifest.source_url", name: t("源码"), render: (url: string) => <SourceLink url={url} /> },
        ]} />
      <More next={results.next} busy={results.busy} load={() => void results.loadMore()} />
    </div> : !results.error && <Empty title={t(kind ? "没有该类型的插件条目" : "这个主题还没有插件条目")} />}
    {details && <Drawer title={details.manifest.name} close={() => setDetails(undefined)} size="s">
      <div className="stack">
        <EuiText size="s">
          <dl>
            <dt>{t("插件 ID")}</dt><dd><code>{details.manifest.id}</code></dd>
            <dt>{t("版本")}</dt><dd>{details.manifest.version}</dd>
            {details.manifest.sha256 && <><dt>SHA-256</dt><dd><code className="new-token">{details.manifest.sha256}</code></dd></>}
          </dl>
          <p>{details.manifest.description}</p>
        </EuiText>
        <SourceLink url={details.manifest.source_url} />
        <EuiCallOut size="s" title={t("请按源码仓库的说明安装。")} />
      </div>
    </Drawer>}
  </>;
}

function SourceLink({ url }: { url: string }) {
  const t = useT();
  if (!url.startsWith("https://")) return null;
  return <EuiLink href={url} target="_blank" rel="noopener noreferrer" external>{t("查看源码")}</EuiLink>;
}

function PublishListing({ api, topic, close, done }: { api: Api; topic: string; close: () => void; done: (kind: Kind) => void }) {
  const t = useT();
  const id = useId();
  const task = useMutation();
  const [value, setValue] = useState<Manifest>({
    id: "", kind: "channel", version: "", name: "", description: "", source_url: "", sha256: "",
  });
  const change = <K extends keyof Manifest>(key: K, content: Manifest[K]) =>
    setValue((previous) => ({ ...previous, [key]: content }));

  return <Drawer title={t("发布插件条目")} close={close}
    footer={<><EuiButtonEmpty onClick={close}>{t("取消")}</EuiButtonEmpty><EuiButton type="submit" form={id} fill isLoading={task.busy}>{t("发布条目")}</EuiButton></>}>
    <form id={id} className="stack" onSubmit={(event) => {
      event.preventDefault();
      void task.run(async () => {
        await api.write(listingsPath(topic), "POST", { ...value, sha256: value.sha256 || undefined });
        done(value.kind);
      });
    }}>
      <EuiText size="s"><p>{t("将此版本发布到「{topic}」。", { topic })}</p></EuiText>
      <Failure message={task.error} />
      <EuiFormRow label={t("名称")} fullWidth>
        <EuiFieldText fullWidth required maxLength={160} value={value.name} onChange={(event) => change("name", event.target.value)} />
      </EuiFormRow>
      <EuiFormRow label={t("插件 ID")} fullWidth>
        <EuiFieldText fullWidth required maxLength={96} pattern="[a-z0-9]+([._\-][a-z0-9]+)*" value={value.id}
          onChange={(event) => change("id", event.target.value)} />
      </EuiFormRow>
      <div className="form-grid">
        <EuiFormRow label={t("版本")} fullWidth>
          <EuiFieldText fullWidth required maxLength={128} placeholder="1.0.0" value={value.version}
            onChange={(event) => change("version", event.target.value)} />
        </EuiFormRow>
        <EuiFormRow label={t("插件类型")} fullWidth>
          <EuiSelect fullWidth value={value.kind} onChange={(event) => change("kind", event.target.value as Kind)}
            options={Object.entries(kinds).map(([value, label]) => ({ value, text: t(label) }))} />
        </EuiFormRow>
      </div>
      <EuiFormRow label={t("说明")} fullWidth>
        <EuiTextArea fullWidth required rows={3} maxLength={4096} value={value.description}
          onChange={(event) => change("description", event.target.value)} />
      </EuiFormRow>
      <EuiFormRow label={t("源码仓库或发布链接")} fullWidth>
        <EuiFieldText fullWidth required type="url" maxLength={2048} placeholder="https://" value={value.source_url}
          onChange={(event) => change("source_url", event.target.value)} />
      </EuiFormRow>
      <EuiFormRow label={t("SHA-256 校验值（可选）")} fullWidth>
        <EuiFieldText fullWidth pattern="[a-fA-F0-9]{64}" maxLength={64} value={value.sha256}
          onChange={(event) => change("sha256", event.target.value)} />
      </EuiFormRow>
    </form>
  </Drawer>;
}
