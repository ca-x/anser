import { useEffect, useId, useRef, useState } from "react";
import { EuiButton, EuiCallOut, EuiFieldText, EuiFormRow, EuiLink, EuiSelect, EuiTextArea } from "@elastic/eui";
import { Api, segment, type InstalledPlugin, type JsonObject, type Message, type Receipt } from "../api";
import { configDefaults, dynamicOptionInputs, serializeConfig } from "../form-values";
import { useT } from "../preferences";
import { useMutation, useResource } from "../resources";
import { ChannelFields, type DynamicChoices } from "./ChannelFields";
import { Drawer, Failure, JsonInput, object, Progress } from "./Common";

interface Artifact {
  name: string;
  content_type: string;
  content_base64: string;
}
interface RunResult {
  message?: Message;
  notifications?: Message[];
  artifacts?: Artifact[];
  details?: JsonObject;
}
interface SavedConfig {
  config: JsonObject;
  saved_credentials: string[];
  revision: string | null;
}

function usePluginChoices(api: Api, path: string, inputs: string, revision?: string) {
  const [result, setResult] = useState<{ inputs: string; revision?: string; choices: Record<string, DynamicChoices> }>();
  useEffect(() => {
    const controller = new AbortController();
    const fields = Object.entries(JSON.parse(inputs) as Record<string, JsonObject>);
    if (!fields.length) return;
    setResult({ inputs, revision, choices: Object.fromEntries(fields.map(([key]) => [key, { loading: true }])) });
    const timer = window.setTimeout(() => {
      for (const [field, config] of fields) {
        const report = (choice: DynamicChoices) => {
          if (!controller.signal.aborted) {
            setResult((current) => current && ({ ...current, choices: { ...current.choices, [field]: choice } }));
          }
        };
        void api.write<Required<Pick<DynamicChoices, "items">>>(`${path}/options/${segment(field)}`, "POST",
          { config, config_revision: revision }, 15_000, controller.signal)
          .then(({ items }) => report({ items }), () => report({ failed: true }));
      }
    }, 350);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [api, inputs, path, revision]);
  return result?.inputs === inputs && result.revision === revision ? result.choices : undefined;
}

const playable = new Set(["audio/mpeg", "audio/ogg", "audio/wav", "audio/aac", "audio/flac"]);

function ArtifactDownload({ artifact }: { artifact: Artifact }) {
  const t = useT();
  const [href, setHref] = useState("");
  const audio = playable.has(artifact.content_type);
  useEffect(() => {
    const bytes = Uint8Array.from(atob(artifact.content_base64), (byte) => byte.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], {
      type: audio ? artifact.content_type : "application/octet-stream",
    }));
    setHref(url);
    return () => URL.revokeObjectURL(url);
  }, [artifact, audio]);

  return <div className="stack">
    {audio && href && <audio controls src={href} aria-label={artifact.name} />}
    {href && <EuiButton size="s" iconType="download" href={href} download={artifact.name}>{t("下载 {name}", { name: artifact.name })}</EuiButton>}
  </div>;
}

export function PluginRunner({ api, plugin, close }: { api: Api; plugin: InstalledPlugin; close: () => void }) {
  const t = useT();
  const form = useId();
  const [draft, setDraft] = useState<JsonObject>();
  const [savedOverride, setSavedOverride] = useState<SavedConfig>();
  const [source, setSource] = useState("");
  const [result, setResult] = useState<RunResult>();
  const task = useMutation();
  const saving = useMutation();
  const [notice, setNotice] = useState(false);
  const [destination, setDestination] = useState("preview");
  const [target, setTarget] = useState("");
  const [receipt, setReceipt] = useState<Receipt>();
  const pendingKey = useRef<string | undefined>(undefined);
  function resetSubmission() {
    pendingKey.current = undefined;
    setReceipt(undefined);
  }
  const transform = plugin.kind === "content_transform";
  const metadata = plugin.config_schema["x-anser-ui"] as { task_input?: string; persistent_settings?: boolean } | undefined;
  const path = `/plugins/${plugin.kind}/${segment(plugin.id)}`;
  const persistent = transform && metadata?.persistent_settings === true;
  const settingsPath = persistent ? `${path}/config` : undefined;
  const settings = useResource<SavedConfig>(api, settingsPath);
  const saved = savedOverride ?? settings.data;
  const config = draft ?? { ...configDefaults(plugin.config_schema), ...saved?.config };
  const revision = saved?.revision ?? undefined;
  const ready = !persistent || !!saved;
  const choices = usePluginChoices(api, path,
    JSON.stringify(persistent && ready ? dynamicOptionInputs(plugin, config, saved) : {}), revision);
  const taskInput = !transform && metadata?.task_input !== "none";
  const speech = transform && plugin.id === "openai-tts";
  const sending = speech && destination !== "preview";
  const saveConfig = () => saving.run(async () => {
    if (!settingsPath) return;
    setNotice(false);
    setSavedOverride(await api.write<SavedConfig>(settingsPath, "PUT", {
      config: serializeConfig(plugin, config), config_revision: revision,
    }));
    setDraft(undefined);
    resetSubmission();
    setNotice(true);
  });

  return <Drawer title={plugin.display_name} close={close}
    footer={<>
    {persistent && <EuiButton type="button" onClick={() => { void saveConfig(); }} isLoading={saving.busy} disabled={!ready || task.busy}>
      {t("保存插件配置")}
    </EuiButton>}
    <EuiButton type="submit" form={form} fill isLoading={task.busy} isDisabled={!plugin.available || !ready || saving.busy}>
      {t(sending ? "发送语音通知" : "运行插件")}
    </EuiButton></>}>
    <form id={form} className="stack" onSubmit={(event) => {
      event.preventDefault();
      if (task.busy || saving.busy || !plugin.available || !ready) return;
      setResult(undefined);
      void task.run(async () => {
        const fields = serializeConfig(plugin, config);
        const invocation = { config: fields, config_revision: revision };
        if (sending) {
          const key = pendingKey.current ??= crypto.randomUUID();
          const targetValue = target.trim();
          const address = destination === "inbox" ? { kind: destination, username: targetValue }
            : destination === "topic" ? { kind: destination, name: targetValue } : { kind: "channels" };
          const accepted = await api.sendSpeech({
            ...invocation, message: { body: source, format: "text" }, destination: address,
          }, key);
          pendingKey.current = undefined;
          setReceipt(accepted);
          return;
        }
        const input = transform ? { message: { body: source, format: "text" } } : taskInput ? { input: object(source || "{}") } : {};
        setResult(await api.write<RunResult>(`${path}/run`, "POST", { ...invocation, ...input }, 65_000));
      });
    }}>
      <Failure message={task.error} />
      {persistent && !ready && settings.loading && <Progress />}
      {persistent && <Failure message={settings.error || saving.error} retry={settings.error ? settings.reload : undefined} />}
      {notice && <EuiCallOut title={t("插件配置已保存。")} color="success" iconType="check" size="s" announceOnMount />}
      {ready && <fieldset disabled={saving.busy}>
        <ChannelFields channel={plugin} value={config} savedCredentials={saved?.saved_credentials} dynamicChoices={choices}
          update={(value) => { setDraft(value); setNotice(false); resetSubmission(); }} />
      </fieldset>}
      {speech && <EuiFormRow label={t("语音通知用途")} fullWidth>
        <EuiSelect value={destination} fullWidth onChange={(event) => {
          setDestination(event.target.value); setTarget(""); setResult(undefined); resetSubmission();
        }} options={[
          { value: "preview", text: t("仅合成与预览") },
          { value: "inbox", text: t("个人收件箱") },
          { value: "topic", text: t("发布到主题") },
          { value: "channels", text: t("按默认路由发送") },
        ]} />
      </EuiFormRow>}
      {sending && destination !== "channels" && <EuiFormRow fullWidth
        label={t(destination === "inbox" ? "收件用户名" : "主题名称")}>
        <EuiFieldText fullWidth required value={target} onChange={(event) => {
          setTarget(event.target.value); resetSubmission();
        }} />
      </EuiFormRow>}
      {receipt && <EuiCallOut color="success" iconType="check" title={t("语音通知已提交")}>
        <EuiLink href={`/admin/messages/${segment(receipt.message_id)}`}>{t("查看投递结果")}</EuiLink>
      </EuiCallOut>}
      {transform ? <EuiFormRow label={t("待转换内容")} fullWidth>
        <EuiTextArea required fullWidth value={source} onChange={(event) => { setSource(event.target.value); resetSubmission(); }} />
      </EuiFormRow> : taskInput && <JsonInput label={t("任务输入")} value={source} set={setSource} />}
      {result && <section className="stack" aria-label={t("运行结果")}>
        <h3>{t("运行结果")}</h3>
        {[...(result.message ? [result.message] : []), ...(result.notifications ?? [])].map((message, index) =>
          <div key={index}>
            {message.title && <strong>{message.title}</strong>}
            <p className="plugin-result-text">{message.body}</p>
          </div>)}
        {result.notifications?.length === 0 && <p>{t("本次运行没有生成通知。")}</p>}
        {result.details && <pre className="plugin-result-text">{JSON.stringify(result.details, null, 2)}</pre>}
        {result.artifacts?.map((artifact, index) => <ArtifactDownload key={index} artifact={artifact} />)}
      </section>}
    </form>
  </Drawer>;
}
