import type { Account, Channel, JsonObject, LazycatDevices } from "./api";

export function split(value: string) {
  return [...new Set(value.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean))];
}

export type ConfigSchema = Pick<Channel, "id" | "config_schema">;

type Condition = { field: string; equals: string | number | boolean };

type LocalizedText = Partial<Record<"zh-CN" | "en", string>>;

interface ConfigPreset {
  id: string;
  label: LocalizedText;
  description?: LocalizedText;
  values: JsonObject;
}

interface Presentation {
  presets?: ConfigPreset[];
  account_editor?: { fields: string[]; credentials?: Record<string, string[]> };
  dynamic_options?: { fields: string[] };
  form_fields?: string[];
  links?: {label: LocalizedText; url: string}[];
  visible_when?: Condition;
  required_when?: Condition;
  label?: LocalizedText;
  description?: LocalizedText;
  option_labels?: Record<string, LocalizedText>;
  widget?: string;
}

export function dynamicOptionInputs(plugin: ConfigSchema, draft: JsonObject, saved?: { config: JsonObject; saved_credentials: string[] }) {
  const editor = (plugin.config_schema["x-anser-ui"] as Presentation | undefined)?.account_editor;
  return Object.fromEntries(Object.entries(pluginProperties(plugin)).flatMap(([name, property]) => {
    const fields = property["x-anser-ui"]?.dynamic_options?.fields;
    if (!Array.isArray(fields) || !fields.length) return [];
    const ready = fields.every((key) => (typeof draft[key] === "string" && draft[key].trim()) ||
      (saved?.saved_credentials.includes(key) &&
        (editor?.credentials?.[key] ?? []).every((field) => draft[field] === saved.config[field])));
    return ready ? [[name, Object.fromEntries(fields.filter((key) => Object.hasOwn(draft, key)).map((key) => [key, draft[key]]))]] : [];
  }));
}

export interface ConfigProperty {
  type?: string;
  title?: string;
  enum?: (string | number)[];
  default?: unknown;
  format?: string;
  writeOnly?: boolean;
  minimum?: number;
  maximum?: number;
  description?: string;
  "x-anser-ui"?: Presentation;
}

export function pluginProperties(plugin: ConfigSchema): Record<string, ConfigProperty> {
  const { properties } = plugin.config_schema;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return {};
  return Object.fromEntries(Object.entries(properties).filter(([, value]) =>
    value != null && typeof value === "object" && !Array.isArray(value)));
}

export function matchesCondition(condition: Condition | undefined, value: JsonObject, fields: Record<string, ConfigProperty>) {
  return !!condition && Object.hasOwn(fields, condition.field) &&
    (value[condition.field] ?? fields[condition.field]?.default) === condition.equals;
}

export function visibleField(field: ConfigProperty, value: JsonObject, fields: Record<string, ConfigProperty>) {
  const condition = field["x-anser-ui"]?.visible_when;
  return condition == null || matchesCondition(condition, value, fields);
}

export function configPresets(plugin?: ConfigSchema) {
  const ui = plugin?.config_schema["x-anser-ui"] as Presentation | undefined;
  return Array.isArray(ui?.presets) ? ui.presets.filter((preset) =>
    preset && typeof preset.id === "string" && !!preset.id && preset.label && preset.values &&
    typeof preset.values === "object" && !Array.isArray(preset.values)) : [];
}

export function presetValues(plugin: ConfigSchema, preset: ConfigPreset) {
  const properties = pluginProperties(plugin);
  return Object.fromEntries(Object.entries(preset.values).filter(([key, value]) => {
    const field = Object.hasOwn(properties, key) ? properties[key] : undefined;
    const scalar = typeof value === "string" || typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value));
    return field && scalar && !sensitiveField(key, field) && key !== "proxy" &&
      (field.type === typeof value || (field.type === "integer" && Number.isSafeInteger(value))) &&
      (!field.enum || field.enum.includes(value as string | number));
  }));
}

export function sensitiveField(name: string, field: ConfigProperty) {
  return field.writeOnly || field.format === "password" || /pass(?:word)?|token|secret|key|webhook/i.test(name);
}

export function pluginLabel(plugin: ConfigSchema, language: "zh-CN" | "en") {
  const ui = plugin.config_schema["x-anser-ui"] as Presentation | undefined;
  return ui?.label?.[language];
}

export function supportsAccountEditor(plugin?: ConfigSchema) {
  const ui = plugin?.config_schema["x-anser-ui"] as Presentation | undefined;
  return Array.isArray(ui?.account_editor?.fields);
}

export function accountFormFields(plugin: ConfigSchema) {
  const ui = plugin.config_schema["x-anser-ui"] as Presentation | undefined;
  return Array.isArray(ui?.form_fields) ? ui.form_fields : undefined;
}

export function externalHelpUrl(value: unknown) {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password) return url.href;
  } catch { /* Ignore malformed plugin metadata. */ }
  return undefined;
}

export function usesDevicePicker(plugin?: ConfigSchema) {
  const ui = plugin?.config_schema["x-anser-ui"] as Presentation | undefined;
  return ui?.widget === "lazycat_devices" || (ui?.widget == null && plugin?.id === "lazycat");
}

function configValue(field: ConfigProperty | undefined, value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (field?.type === "array") return split(value);
  if (field?.type === "object") return JSON.parse(value);
  return value;
}

export function serializeConfig(plugin: ConfigSchema, value: JsonObject) {
  const fields = pluginProperties(plugin);
  return Object.fromEntries(Object.entries(value).filter(([key]) =>
    key !== "proxy" && (!fields[key] || visibleField(fields[key], value, fields)),
  ).map(([key, entry]) => [key, configValue(fields[key], entry)]));
}

export interface DeviceTarget { user_id: string; device_ids: string[] }

export function currentDevices(directory: LazycatDevices | undefined, target: DeviceTarget | undefined) {
  return !!(directory && target && target.user_id === directory.user_id && target.device_ids.length
    && target.device_ids.length <= (directory.max_selection ?? 1)
    && target.device_ids.every((id) => directory.devices.some((device) => device.device_id === id)));
}

export function serializeDeviceTarget(target: DeviceTarget | undefined) {
  if (!target) return undefined;
  const { user_id, device_ids } = target;
  return device_ids.length === 1 ? { user_id, device_id: device_ids[0] } : { user_id, device_ids };
}

// Option values use a prefix so a stored profile ID cannot collide with the two actions.
export function initialProxyChoice(account?: Account) {
  if (account?.proxy_id) return `profile:${account.proxy_id}`;
  return account ? "keep" : "direct";
}

export function proxySettings(choice: string, account?: Account): JsonObject {
  if (account && choice === "direct") return { proxy_id: null, inline_proxy: "clear" };
  const patch: JsonObject = account ? { inline_proxy: "keep" } : {};
  if (choice.startsWith("profile:")) {
    const id = choice.slice("profile:".length);
    if (id !== account?.proxy_id) patch.proxy_id = id;
  }
  return patch;
}

export function configDefaults(schema: JsonObject): JsonObject {
  const fields = schema.properties;
  if (!fields || typeof fields !== "object") return {};
  return Object.fromEntries(Object.entries(fields).filter(([, field]) =>
    field && typeof field === "object" && !field.writeOnly && field.format !== "password" && field.default !== undefined
  ).map(([name, field]) => [name, field.default]));
}
