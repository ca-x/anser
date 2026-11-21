import { t } from "nsh/i18n";
import { signal, View } from "nsh";
import { ApiError } from "../api";
import { builtInChannel } from "../channelNames";
import type { Channel, JsonObject } from "../contracts";
import { parseObject } from "../forms";
import { Choice, Field, Hint, Panel, Toggle } from "./Controls";

type Property = {
  type?: string;
  title?: string;
  description?: string;
  format?: string;
  writeOnly?: boolean;
  enum?: unknown[];
  oneOf?: { type?: string }[];
  default?: unknown;
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

function fields(channel?: Channel) {
  const schema = channel?.config_schema;
  const properties = schema?.properties;
  if (
    !properties ||
    typeof properties !== "object" ||
    Array.isArray(properties)
  )
    return [];
  const id = channel?.id ?? "";
  const isBuiltIn = builtInChannel(id);
  const required = Array.isArray(schema.required) ? schema.required : [];
  return Object.entries(properties)
    .filter(([, prop]) => typeof prop === "object" && prop !== null)
    .map(([name, prop]) => {
      const schema = prop as Property;
      return {
        name,
        schema,
        type: fieldType(schema),
        required: required.includes(name),
        label: channelText(
          isBuiltIn,
          `config_field.${name}`,
          schema.title ?? name,
        ),
        hint: channelText(
          isBuiltIn,
          `config_hint.${id}.${name}`,
          schema.description ?? "",
        ),
        options: (Array.isArray(schema.enum) ? schema.enum : [])
          .filter((option): option is string => typeof option === "string")
          .map((value) => ({
            value,
            title: channelText(
              isBuiltIn,
              `config_option.${name}.${value}`,
              value,
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

export function channelConfigDraft(channel: () => Channel | undefined) {
  const values = signal<Record<string, string>>({});
  const raw = signal("");
  const advanced = signal(false);
  const definitions = () => fields(channel());
  const clear = () => {
    values.set({});
    raw.set("");
    advanced.set(false);
  };
  const value = (): JsonObject => {
    const definition = definitions();
    if (advanced() || !definition.length)
      return parseObject(
        raw().trim() || "{}",
        t("common.channel_configuration"),
      );
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
      if (options.some(({ value }) => value === input)) {
        result[name] = input;
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
                              (typeof property().default === "string"
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
