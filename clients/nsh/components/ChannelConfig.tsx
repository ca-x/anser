import { t } from "nsh/i18n";
import { locale, signal, View } from "nsh";
import { ApiError } from "../api";
import { builtInChannel } from "../channelNames";
import type { Channel, JsonObject } from "../contracts";
import { parseObject } from "../forms";
import { Choice, Field, Hint, Panel, Toggle } from "./Controls";

type ConfigSchema = Pick<Channel, "id" | "config_schema">;
type LocaleText = Partial<Record<"en" | "zh-CN", string>>;
type Condition = { field: string; equals: string | number | boolean };
type Presentation = {
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

export function pluginLabel(plugin: ConfigSchema): string | undefined {
  return localized((plugin.config_schema["x-anser-ui"] as Presentation | undefined)?.label);
}

export function usesDevicePicker(plugin?: ConfigSchema): boolean {
  const ui = plugin?.config_schema["x-anser-ui"] as Presentation | undefined;
  return ui?.widget === "lazycat_devices" || (ui?.widget == null && plugin?.id === "lazycat");
}

function fields(channel: ConfigSchema | undefined, values: Record<string, string>) {
  const schema = channel?.config_schema;
  const properties = schema?.properties;
  if (!schema || !properties || typeof properties !== "object" || Array.isArray(properties))
    return [];

  const fields = properties as Record<string, Property>;
  const id = channel?.id ?? "";
  const isBuiltIn = builtInChannel(id);
  const required = Array.isArray(schema.required) ? schema.required : [];
  function matches(condition: Condition | undefined): boolean {
    if (!condition || !Object.hasOwn(fields, condition.field)) return false;
    const value = values[condition.field];
    return value === undefined || value === ""
      ? fields[condition.field]?.default === condition.equals
      : value === String(condition.equals);
  }
  return Object.entries(fields)
    .filter(([name, field]) => name !== "proxy" && field && typeof field === "object" && !Array.isArray(field))
    .filter(([, field]) => !field["x-anser-ui"]?.visible_when || matches(field["x-anser-ui"]?.visible_when))
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

export function channelConfigDraft(channel: () => ConfigSchema | undefined) {
  const values = signal<Record<string, string>>({});
  const raw = signal("");
  const advanced = signal(false);
  const definitions = () => fields(channel(), values());
  const clear = () => {
    values.set({});
    raw.set("");
    advanced.set(false);
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
        if (required && schema.default === undefined) {
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
  return { values, raw, advanced, definitions, clear, value };
}

export function ChannelConfig(props: {
  draft: ReturnType<typeof channelConfigDraft>;
}) {
  function write(name: string, value: string) {
    props.draft.values.update((previous) => ({ ...previous, [name]: value }));
  }

  return (
    <Panel>
      <If when={props.draft.definitions().length > 0}>
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
            <Each of={props.draft.definitions()} key={(field) => field.name}>
              {(field) => {
                const property = () => field().schema;
                const masked = () => secretField(field().name, property());
                const label = () =>
                  field().required
                    ? t("channel_config.required_field", {
                        name: field().label,
                      })
                    : field().label;
                return (
                  <If
                    when={field().type === "boolean"}
                    else={
                      <If
                        when={field().options.length > 0}
                        else={
                          <Field
                            label={label()}
                            hint={field().hint}
                            value={props.draft.values()[field().name] ?? ""}
                            onChange={(value) => write(field().name, value)}
                            masked={masked()}
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
