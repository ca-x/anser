import { t } from "nsh/i18n";
import { locale, openUrl, signal, View } from "nsh";
import { ApiError } from "../api";
import { builtInChannel } from "../channelNames";
import type { Channel, JsonObject, PluginChoice, SavedTransformConfig } from "../contracts";
import { parseObject } from "../forms";
import { Action, Choice, Field, Hint, Panel, Problem, Toggle } from "./Controls";

type ConfigSchema = Pick<Channel, "id" | "config_schema">;
type LocaleText = Partial<Record<"en" | "zh-CN", string>>;
type Condition = { field: string; equals: string | number | boolean };
type ConfigPreset = { id: string; label: LocaleText; description?: LocaleText; values: JsonObject };
type Presentation = {
  help?: LocaleText;
  presets?: ConfigPreset[];
  account_editor?: { fields: string[]; credentials?: Record<string, string[]> };
  dynamic_options?: { fields: string[] };
  persistent_settings?: boolean;
  form_fields?: string[];
  links?: { label: LocaleText; url: string }[];
  visible_when?: Condition;
  required_when?: Condition;
  label?: LocaleText;
  description?: LocaleText;
  option_labels?: Record<string, LocaleText>;
  widget?: string;
};

type Property = {
  type?: string;
  title?: string;
  description?: string;
  format?: string;
  writeOnly?: boolean;
  enum?: unknown[];
  oneOf?: { type?: string }[];
  default?: unknown;
  "x-anser-ui"?: Presentation;
};

function channelText(
  isBuiltIn: boolean,
  key: string,
  fallback: string,
): string {
  if (!isBuiltIn) return fallback;
  const translation = t(key);
  return translation.endsWith(`.${key}`) ? fallback : translation;
}

// A free-form string can represent either branch of the Telegram chat ID schema.
function fieldType(property: Property) {
  return (
    property.type ??
    (property.oneOf?.some(({ type }) => type === "string") &&
    property.oneOf.every(({ type }) => type === "string" || type === "integer")
      ? "string"
      : undefined)
  );
}

function localized(value: LocaleText | undefined): string | undefined {
  return value?.[locale().toLowerCase().startsWith("zh") ? "zh-CN" : "en"];
}

export function pluginHelp(plugin: ConfigSchema) {
  const help = localized((plugin.config_schema["x-anser-ui"] as Presentation | undefined)?.help);
  return typeof help === "string" ? help.trim() : "";
}

export function pluginLabel(plugin: ConfigSchema): string | undefined {
  return localized((plugin.config_schema["x-anser-ui"] as Presentation | undefined)?.label);
}

export function supportsAccountEditor(plugin?: ConfigSchema) {
  const ui = plugin?.config_schema["x-anser-ui"] as Presentation | undefined;
  return Array.isArray(ui?.account_editor?.fields);
}

export function supportsTransformSettings(plugin: ConfigSchema) {
  const ui = plugin.config_schema["x-anser-ui"] as Presentation | undefined;
  return ui?.persistent_settings === true;
}

export function transformDraft(plugin: ConfigSchema, saved: SavedTransformConfig) {
  return Object.fromEntries(fields(plugin).flatMap(({ name, schema }) => {
    const value = saved.config[name] ?? (!secretField(name, schema) ? schema.default : undefined);
    if (value == null) return [];
    return [[name, typeof value === "object" ? JSON.stringify(value) : String(value)]];
  }));
}

export function dynamicOptionInputs(plugin: ConfigSchema, draft: Record<string, string>, saved: SavedTransformConfig) {
  const editor = (plugin.config_schema["x-anser-ui"] as Presentation | undefined)?.account_editor;
  return Object.fromEntries(fields(plugin).flatMap(({ name, schema }) => {
    const inputs = schema["x-anser-ui"]?.dynamic_options?.fields;
    if (!Array.isArray(inputs) || !inputs.length) return [];
    const ready = inputs.every((key) => draft[key]?.trim() ||
      (saved.saved_credentials.includes(key) &&
        (editor?.credentials?.[key] ?? []).every((field) => draft[field] === saved.config[field])));
    return ready ? [[name, Object.fromEntries(inputs.filter((key) => draft[key]?.trim()).map((key) => [key, draft[key]]))]] : [];
  }));
}

function helpLinks(property: Property) {
  const links = property["x-anser-ui"]?.links;
  return Array.isArray(links) ? links.flatMap((link) => {
    const title = localized(link?.label);
    if (!title || typeof link?.url !== "string") return [];
    try {
      const url = new URL(link.url);
      return url.protocol === "https:" && !url.username && !url.password ? [{ title, url: url.href }] : [];
    } catch {
      return [];
    }
  }) : [];
}

export function usesDevicePicker(plugin?: ConfigSchema): boolean {
  const ui = plugin?.config_schema["x-anser-ui"] as Presentation | undefined;
  return ui?.widget === "lazycat_devices" || (ui?.widget == null && plugin?.id === "lazycat");
}

function fields(channel: ConfigSchema | undefined, values?: Record<string, string>) {
  const schema = channel?.config_schema;
  const properties = schema?.properties;
  if (!schema || !properties || typeof properties !== "object" || Array.isArray(properties))
    return [];

  const fields = properties as Record<string, Property>;
  const id = channel?.id ?? "";
  const isBuiltIn = builtInChannel(id);
  const required = Array.isArray(schema.required) ? schema.required : [];
  const presented = (schema["x-anser-ui"] as Presentation | undefined)?.form_fields;
  const entries = Array.isArray(presented)
    ? presented.filter((name) => Object.hasOwn(fields, name)).map((name) => [name, fields[name]] as const)
    : Object.entries(fields);
  function matches(condition: Condition | undefined): boolean {
    if (!condition || !Object.hasOwn(fields, condition.field)) return false;
    const value = values?.[condition.field];
    return value === undefined || value === ""
      ? fields[condition.field]?.default === condition.equals
      : value === String(condition.equals);
  }
  return entries
    .filter(([name, field]) => name !== "proxy" && field && typeof field === "object" && !Array.isArray(field))
    .filter(([, field]) => !values || !field["x-anser-ui"]?.visible_when || matches(field["x-anser-ui"]?.visible_when))
    .map(([name, field]) => {
      const ui = field["x-anser-ui"];
      return {
        name,
        schema: field,
        type: fieldType(field),
        required: required.includes(name) || matches(ui?.required_when),
        label: localized(ui?.label) ?? channelText(
          isBuiltIn,
          `config_field.${id}.${name}`,
          channelText(isBuiltIn, `config_field.${name}`, field.title ?? name),
        ),
        hint: localized(ui?.description) ?? channelText(
          isBuiltIn,
          `config_hint.${id}.${name}`,
          field.description ?? "",
        ),
        options: (Array.isArray(field.enum) ? field.enum : [])
          .filter((option): option is string | number => typeof option === "string" || typeof option === "number")
          .map((option) => ({
            value: String(option),
            option,
            title: localized(ui?.option_labels?.[String(option)]) ?? channelText(
              isBuiltIn,
              `config_option.${name}.${option}`,
              String(option),
            ),
          })),
      };
    });
}

function secretField(name: string, property: Property) {
  return (
    property.writeOnly ||
    property.format === "password" ||
    /secret|token|pass(?:word)?|key|webhook/i.test(name)
  );
}

export function supportsProxy(channel?: Channel) {
  const properties = channel?.config_schema.properties;
  return Boolean(
    properties && typeof properties === "object" && "proxy" in properties,
  );
}

export function channelConfigDraft(channel: () => ConfigSchema | undefined, savedCredentials: () => string[] = () => []) {
  const values = signal<Record<string, string>>({});
  const raw = signal("");
  const presetId = signal<string | undefined>(undefined);
  const presets = () => {
    const ui = channel()?.config_schema["x-anser-ui"] as Presentation | undefined;
    return Array.isArray(ui?.presets) ? ui.presets.filter((preset) =>
      preset && typeof preset.id === "string" && !!preset.id && preset.label && preset.values &&
      typeof preset.values === "object" && !Array.isArray(preset.values)) : [];
  };
  const presetValues = (preset: ConfigPreset) =>
    Object.fromEntries(fields(channel()).flatMap(({ name, schema, type }) => {
      const value = preset.values[name];
      if (secretField(name, schema)) return [];
      if (typeof value !== "string" && typeof value !== "boolean" &&
        !(typeof value === "number" && Number.isFinite(value))) return [];
      if (schema.enum && !schema.enum.includes(value)) return [];
      if (type !== typeof value && !(type === "integer" && Number.isSafeInteger(value))) return [];
      return [[name, String(value)]];
    }));
  const selected = () => presets().find((preset) => (presetId() === undefined || preset.id === presetId()) &&
    Object.entries(presetValues(preset)).every(([key, value]) => values()[key] === value));
  const choosePreset = (id: string | null) => {
    presetId.set(id ?? "");
    const preset = presets().find((entry) => entry.id === id);
    if (!preset) return;
    const defaults = presetValues(preset);
    const current = values();
    const next = { ...current, ...defaults };
    if (Object.entries(defaults).some(([key, value]) => current[key] !== value)) {
      for (const { name, schema } of fields(channel())) if (secretField(name, schema)) delete next[name];
    }
    values.set(next);
  };
  const advanced = signal(false);
  const definitions = () => fields(channel(), values());
  const clear = () => {
    values.set({});
    raw.set("");
    advanced.set(false);
    presetId.set("");
  };
  const value = (): JsonObject => {
    const definition = definitions();
    if (advanced() || !definition.length) {
      const result = parseObject(
        raw().trim() || "{}",
        t("common.channel_configuration"),
      );
      if ("proxy" in result)
        throw new ApiError("inline_proxy", t("proxies.choose_profile"));
      return result;
    }
    const result: JsonObject = {};
    const entered = values();
    for (const field of definition) {
      const { name, schema, required, type, label, options } = field;
      const input = entered[name];
      if (input === undefined || !input.trim()) {
        if (required && schema.default === undefined && !savedCredentials().includes(name)) {
          if (type === "boolean") result[name] = false;
          else
            throw new ApiError(
              "missing_config",
              t("channel_config.field_required", {
                field: label,
              }),
            );
        }
        continue;
      }
      const selected = options.find(({ value }) => value === input);
      if (selected) {
        result[name] = selected.option;
      } else if (type === "array" || type === "object" || !type) {
        try {
          result[name] = JSON.parse(input);
        } catch {
          throw new ApiError(
            "invalid_json",
            t("channel_config.invalid_field_json", {
              field: label,
            }),
          );
        }
      } else if (type === "integer" || type === "number") {
        const number = Number(input);
        if (
          !Number.isFinite(number) ||
          (type === "integer" && !Number.isSafeInteger(number))
        ) {
          throw new ApiError(
            "invalid_number",
            t("channel_config.invalid_field_number", {
              field: label,
            }),
          );
        }
        result[name] = number;
      } else {
        result[name] = type === "boolean" ? input === "true" : input;
      }
    }
    return result;
  };
  return { values, raw, advanced, definitions, clear, value, presets, selected, choosePreset, savedCredentials };
}

export function ChannelConfig(props: {
  draft: ReturnType<typeof channelConfigDraft>;
  guided?: boolean;
  choices?: Record<string, { items?: PluginChoice[]; loading?: boolean; failed?: boolean }>;
}) {
  const linkError = signal("");
  function write(name: string, value: string) {
    props.draft.values.update((previous) => ({ ...previous, [name]: value }));
  }

  return (
    <Panel>
      <Problem message={linkError()} />
      <If when={!props.guided && props.draft.definitions().length > 0 &&
        !props.draft.definitions().some(({ schema }) => helpLinks(schema).length > 0)}>
        <Toggle
          label={t("channel_config.edit_configuration_as_json")}
          checked={props.draft.advanced()}
          onChange={props.draft.advanced.set}
        />
      </If>
      <If
        when={props.draft.advanced() || !props.draft.definitions().length}
        else={
          <View class="gap-3">
            <If when={props.draft.presets().length > 0}>
              <Choice label={t("channel_config.connection_preset")} value={props.draft.selected()?.id ?? ""}
                items={[{ value: "", title: t("channel_config.manual_setup") }, ...props.draft.presets().map((preset) =>
                  ({ value: preset.id, title: localized(preset.label) ?? preset.id }))]}
                onChange={props.draft.choosePreset} />
              <If when={localized(props.draft.selected()?.description)}>
                {(hint) => <Hint>{hint()}</Hint>}
              </If>
            </If>
            <Each of={props.draft.definitions()} key={(field) => field.name}>
              {(field) => {
                const property = () => field().schema;
                const masked = () => secretField(field().name, property());
                const remote = () => props.choices?.[field().name];
                const chosen = () => props.draft.values()[field().name] ?? "";
                const canChoose = () => (remote()?.items?.length ?? 0) > 0;
                const selectedChoice = () => remote()?.items?.some(({ value }) => value === chosen());
                const label = () =>
                  field().required && !props.draft.savedCredentials().includes(field().name)
                    ? t("channel_config.required_field", {
                        name: field().label,
                      })
                    : field().label;
                return (
                  <View class="gap-2">
                  <If when={canChoose()}>
                    <Choice label={label()} value={selectedChoice() ? chosen() : ""}
                      items={[
                        ...(remote()?.items ?? []).map(({ label: title, value }) => ({ title, value })),
                        { title: t("channel_config.manual_value"), value: "" },
                      ]}
                      onChange={(value) => write(field().name, value ?? "")}
                    />
                  </If>
                  <If when={remote()?.loading}><Hint>{t("channel_config.loading_options")}</Hint></If>
                  <If when={remote()?.failed}><Hint>{t("channel_config.options_failed")}</Hint></If>
                  <If when={remote()?.items?.length === 0}><Hint>{t("channel_config.no_options")}</Hint></If>
                  <If when={!canChoose() || !selectedChoice()}>
                  <If
                    when={field().type === "boolean"}
                    else={
                      <If
                        when={field().options.length > 0}
                        else={
                          <Field
                            label={canChoose() ? t("channel_config.custom_value", { name: field().label }) : label()}
                            hint={props.draft.savedCredentials().includes(field().name)
                              ? t("channel_config.keep_saved_credential") : field().hint}
                            value={props.draft.values()[field().name] ?? ""}
                            onChange={(value) => write(field().name, value)}
                            masked={masked()}
                            keyboard={field().type === "integer" || field().type === "number" ? "numeric" : undefined}
                            multiline={
                              !masked() &&
                              ["array", "object"].includes(field().type ?? "")
                            }
                            placeholder={
                              field().type === "array"
                                ? "[]"
                                : field().type === "object"
                                  ? "{}"
                                  : undefined
                            }
                          />
                        }
                      >
                        <View class="gap-1">
                          <Choice
                            label={label()}
                            value={
                              props.draft.values()[field().name] ??
                              (["string", "number"].includes(typeof property().default)
                                ? String(property().default)
                                : null)
                            }
                            items={field().options}
                            onChange={(value) =>
                              write(field().name, value ?? "")
                            }
                          />
                          <If when={field().hint}>
                            <Hint>{field().hint}</Hint>
                          </If>
                        </View>
                      </If>
                    }
                  >
                    <View class="gap-1">
                      <Toggle
                        label={label()}
                        checked={
                          (props.draft.values()[field().name] ??
                            String(property().default ?? false)) === "true"
                        }
                        onChange={(value) => write(field().name, String(value))}
                      />
                      <If when={field().hint}>
                        <Hint>{field().hint}</Hint>
                      </If>
                    </View>
                  </If>
                  </If>
                  <Each of={helpLinks(property())} key={(link) => link.url}>
                    {(link) => <Action kind="quiet" label={link().title} onPress={() => {
                      linkError.set("");
                      void openUrl(link().url).catch(() => linkError.set(t("channel_config.open_link_error")));
                    }} />}
                  </Each>
                  </View>
                );
              }}
            </Each>
          </View>
        }
      >
        <Field
          label={t("channel_config.channel_configuration_json")}
          multiline
          value={props.draft.raw()}
          onChange={props.draft.raw.set}
          hint={t("channel_config.json_mode_shows_the_text_you")}
          placeholder="{}"
        />
      </If>
    </Panel>
  );
}
