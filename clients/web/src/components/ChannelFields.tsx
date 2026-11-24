import { useLanguage, useT } from "../preferences";
import { EuiFieldNumber, EuiFieldPassword, EuiFieldText, EuiFormRow, EuiSelect, EuiTextArea } from "@elastic/eui";
import type { JsonObject } from "../api";
import { matchesCondition, pluginProperties, visibleField, type ConfigSchema } from "../form-values";
import { channelConfigOptionName } from "../locale";

const fieldNames: Record<string, string> = {
  host: "主机", port: "端口", encryption: "加密方式", username: "用户名", password: "密码",
  from: "发件地址", to: "收件地址", server_url: "服务器地址", topic: "主题", token: "令牌",
  priority: "优先级", device_key: "设备密钥", device_keys: "设备密钥列表",
  user_id: "用户 ID", device_id: "设备 ID", group: "分组", sound: "提示音", level: "通知级别",
  bot_token: "机器人令牌", chat_id: "聊天 ID", parse_mode: "解析模式", sendkey: "SendKey",
  signing_secret: "签名密钥", webhook: "Webhook 地址", app_id: "应用 ID", app_secret: "应用密钥",
  receive_id: "接收目标", receive_id_type: "接收目标类型", region: "区域", appid: "公众号 AppID",
  encryption_key: "加密密钥", secret: "应用密钥", template_id: "模板 ID", openid: "OpenID", corpid: "企业 ID", agentid: "应用 ID",
  title_field: "标题字段", body_field: "正文字段", touser: "成员 ID", mode: "接入方式",
  channel_id: "频道 ID", app_token: "应用令牌", event_name: "事件名称", webhook_key: "Webhook 密钥",
  recipient_kind: "接收目标类型", recipient_id: "接收目标 ID", sandbox: "沙箱模式",
};

export function ChannelFields({ channel, value, update }: {
  channel: ConfigSchema; value: JsonObject; update: (value: JsonObject) => void;
}) {
  const t = useT();
  const language = useLanguage();
  const schema = channel.config_schema;
  const fields = pluginProperties(channel);
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);

  function change(key: string, content: unknown) {
    const next = { ...value, [key]: content };
    if (content === "") delete next[key];
    update(next);
  }

  return <div className="stack">{Object.entries(fields).filter(([key, field]) =>
    key !== "proxy" && visibleField(field, value, fields)).map(([key, field]) => {
    const entry = value[key] ?? "";
    const ui = field["x-anser-ui"];
    const label = ui?.label?.[language] || t(field.title || fieldNames[key] || key);
    const placeholder = typeof field.default === "string" || typeof field.default === "number" ? String(field.default) : undefined;
    const secret = field.writeOnly || field.format === "password" || /password|token|secret|sendkey|webhook/.test(key);
    const isRequired = required.has(key) || matchesCondition(ui?.required_when, value, fields);
    let control;
    if (field.enum) {
      const options = field.enum;
      const labelFor = (option: string | number) => ui?.option_labels?.[String(option)]?.[language] || channelConfigOptionName(language, String(option));
      control = <EuiSelect fullWidth required={isRequired} value={String(entry)} onChange={(event) =>
        change(key, options.find((option) => String(option) === event.target.value) ?? "")}
        options={[{ value: "", text: placeholder ? t("默认 · {value}", { value: labelFor(placeholder) }) : t("请选择") },
          ...options.map((value) => ({ value: String(value), text: labelFor(value) }))]} />;
    } else if (field.type === "boolean") {
      control = <EuiSelect required={isRequired} fullWidth value={String(entry)} onChange={(event) => change(key, event.target.value === "" ? "" : event.target.value === "true")}
        options={[{ value: "", text: typeof field.default === "boolean" ? t("默认 · {value}", { value: t(field.default ? "是" : "否") }) : t("默认") },
          { value: "true", text: t("是") }, { value: "false", text: t("否") }]} />;
    } else if (field.type === "number" || field.type === "integer") {
      control = <EuiFieldNumber fullWidth required={isRequired} min={field.minimum} max={field.maximum} value={entry as number | string}
        step={field.type === "integer" ? 1 : "any"} placeholder={placeholder}
        onChange={(event) => change(key, event.target.value === "" ? "" : event.target.valueAsNumber)} />;
    } else if (field.type === "object" && !secret) {
      control = <EuiTextArea fullWidth required={isRequired} rows={3} value={String(entry)} placeholder="{}"
        onChange={(event) => change(key, event.target.value)} />;
    } else {
      const parseArray = field.type === "array";
      const text = Array.isArray(entry) ? entry.join(", ") : String(entry);
      // Preserve in-progress separators in array controls until submission.
      const set = (item: string) => change(key, item);
      control = secret ? <EuiFieldPassword fullWidth required={isRequired} autoComplete="off" type="password" value={text}
        onChange={(event) => set(event.target.value)} /> : <EuiFieldText fullWidth required={isRequired}
        value={text} placeholder={parseArray ? t("以逗号分隔") : placeholder} onChange={(event) => set(event.target.value)} />;
    }
    const help = ui?.description?.[language]
      || (field.description ? t(field.description) : field.type === "array" ? t("以逗号分隔多个值。") : undefined);
    return <EuiFormRow key={key} label={label} helpText={help} fullWidth>{control}</EuiFormRow>;
  })}</div>;
}
