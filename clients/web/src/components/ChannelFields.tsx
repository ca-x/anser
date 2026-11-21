import { useT } from "../preferences";
import { EuiFieldNumber, EuiFieldPassword, EuiFieldText, EuiFormRow, EuiSelect } from "@elastic/eui";
import type { Channel, JsonObject } from "../api";
import { split } from "./Common";

interface Property {
  type?: string;
  title?: string;
  enum?: string[];
  default?: unknown;
  format?: string;
  writeOnly?: boolean;
  minimum?: number;
  maximum?: number;
  description?: string;
}

const fieldNames: Record<string, string> = {
  host: "主机", port: "端口", encryption: "加密方式", username: "用户名", password: "密码",
  from: "发件地址", to: "收件地址", server_url: "服务器地址", topic: "主题", token: "令牌",
  priority: "优先级", proxy: "出站代理", device_key: "设备密钥", device_keys: "设备密钥列表",
  user_id: "用户 ID", device_id: "设备 ID", group: "分组", sound: "提示音", level: "通知级别",
  bot_token: "机器人令牌", chat_id: "聊天 ID", parse_mode: "解析模式", sendkey: "SendKey",
  signing_secret: "签名密钥", webhook: "Webhook 地址", app_id: "应用 ID", app_secret: "应用密钥",
  receive_id: "接收目标", receive_id_type: "接收目标类型", region: "区域", appid: "公众号 AppID",
  encryption_key: "加密密钥", secret: "应用密钥", template_id: "模板 ID", openid: "OpenID", corpid: "企业 ID", agentid: "应用 ID",
  title_field: "标题字段", body_field: "正文字段", touser: "成员 ID", mode: "接入方式",
};

export function ChannelFields({ channel, value, update }: {
  channel: Channel; value: JsonObject; update: (value: JsonObject) => void;
}) {
  const t = useT();
  const schema = channel.config_schema;
  const fields = (typeof schema.properties === "object" && schema.properties !== null ? schema.properties : {}) as Record<string, Property>;
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  if (value.mode === "app") for (const field of ["app_id", "app_secret", "receive_id"]) required.add(field);
  if (value.mode === "webhook") required.add("webhook");

  function change(key: string, content: unknown) {
    const next = { ...value };
    if (content === "") delete next[key];
    else next[key] = content;
    if (key === "mode" && channel.id === "feishu") for (const field of Object.keys(next)) {
      if (!visible(field, next.mode)) delete next[field];
    }
    update(next);
  }

  return <div className="stack">{Object.entries(fields).filter(([field]) => channel.id !== "feishu" || visible(field, value.mode)).map(([key, field]) => {
    const entry = value[key] ?? "";
    const label = t(field.title || fieldNames[key] || key);
    const placeholder = typeof field.default === "string" || typeof field.default === "number" ? String(field.default) : undefined;
    const secret = field.writeOnly || field.format === "password" || /password|token|secret|sendkey|webhook|proxy/.test(key);
    const isRequired = required.has(key);
    let control;
    if (field.enum) {
      control = <EuiSelect fullWidth required={isRequired} value={String(entry)} onChange={(event) => change(key, event.target.value)}
        options={[{ value: "", text: placeholder ? t("默认 · {value}", { value: placeholder }) : t("请选择") }, ...field.enum.map((value) => ({ value, text: value }))]} />;
    } else if (field.type === "boolean") {
      control = <EuiSelect fullWidth value={String(entry)} onChange={(event) => change(key, event.target.value === "" ? "" : event.target.value === "true")}
        options={[{ value: "", text: t("默认") }, { value: "true", text: t("是") }, { value: "false", text: t("否") }]} />;
    } else if (field.type === "number" || field.type === "integer") {
      control = <EuiFieldNumber fullWidth required={isRequired} min={field.minimum} max={field.maximum} value={entry as number | string}
        step={field.type === "integer" ? 1 : "any"} placeholder={placeholder}
        onChange={(event) => change(key, event.target.value === "" ? "" : event.target.valueAsNumber)} />;
    } else {
      const parseArray = field.type === "array";
      const text = Array.isArray(entry) ? entry.join(", ") : String(entry);
      // Preserve in-progress separators in array controls until submission.
      const set = (item: string) => change(key, item);
      control = secret ? <EuiFieldPassword fullWidth required={isRequired} autoComplete="off" type="password" value={text}
        onChange={(event) => set(event.target.value)} /> : <EuiFieldText fullWidth required={isRequired}
        value={text} placeholder={parseArray ? t("以逗号分隔") : placeholder} onChange={(event) => set(event.target.value)} />;
    }
    const help = field.type === "array" ? t("以逗号分隔多个值。") : field.description && t(field.description);
    return <EuiFormRow key={key} label={label} helpText={help} fullWidth>{control}</EuiFormRow>;
  })}</div>;
}

export function serializeConfig(channel: Channel, value: JsonObject) {
  const fields = channel.config_schema.properties as Record<string, Property> | undefined;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key, fields?.[key]?.type === "array" && typeof entry === "string" ? split(entry) : entry,
  ]));
}

function visible(field: string, mode: unknown) {
  if (["mode", "proxy"].includes(field)) return true;
  if (mode === "webhook") return ["webhook", "signing_secret"].includes(field);
  if (mode === "app") return ["app_id", "app_secret", "receive_id", "receive_id_type", "region"].includes(field);
  return false;
}
