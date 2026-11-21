import { t } from "nsh/i18n";
import { signal, View } from "nsh";
import { ApiError } from "../api";
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
  default?: unknown;
};

function fields(channel?: Channel) {
  const schema = channel?.config_schema;
  const properties = schema?.properties;
  if (
    !properties ||
    typeof properties !== "object" ||
    Array.isArray(properties)
  )
    return [];
  const required = Array.isArray(schema.required) ? schema.required : [];
  return Object.entries(properties)
    .filter(([, prop]) => typeof prop === "object" && prop !== null)
    .map(([name, prop]) => ({
      name,
      schema: prop as Property,
      required: required.includes(name),
    }));
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
      const { name, schema, required } = field;
      const input = entered[name];
      if (input === undefined || !input.trim()) {
        if (required && schema.default === undefined) {
          if (schema.type === "boolean") result[name] = false;
          else
            throw new ApiError(
              "missing_config",
              t("channel_config.field_required", {
                field: schema.title ?? name,
              }),
            );
        }
        continue;
      }
      if (schema.type === "array" || schema.type === "object" || !schema.type) {
        try {
          result[name] = JSON.parse(input);
        } catch {
          throw new ApiError(
            "invalid_json",
            t("channel_config.invalid_field_json", {
              field: schema.title ?? name,
            }),
          );
        }
      } else if (schema.type === "integer" || schema.type === "number") {
        const number = Number(input);
        if (
          !Number.isFinite(number) ||
          (schema.type === "integer" && !Number.isSafeInteger(number))
        ) {
          throw new ApiError(
            "invalid_number",
            t("channel_config.invalid_field_number", {
              field: schema.title ?? name,
            }),
          );
        }
        result[name] = number;
      } else {
        result[name] = schema.type === "boolean" ? input === "true" : input;
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
                const label = () =>
                  field().required
                    ? t("channel_config.required_field", {
                        name: property().title ?? field().name,
                      })
                    : (property().title ?? field().name);
                const enums = () =>
                  property().enum?.filter(
                    (value): value is string => typeof value === "string",
                  ) ?? [];
                return (
                  <If
                    when={property().type === "boolean"}
                    else={
                      <If
                        when={enums().length > 0}
                        else={
                          <Field
                            label={label()}
                            hint={property().description}
                            value={props.draft.values()[field().name] ?? ""}
                            onChange={(value) => write(field().name, value)}
                            masked={
                              secretField(field().name, property()) &&
                              property().type === "string"
                            }
                            multiline={["array", "object"].includes(
                              property().type ?? "",
                            )}
                            placeholder={
                              property().type === "array"
                                ? "[]"
                                : property().type === "object"
                                  ? "{}"
                                  : undefined
                            }
                          />
                        }
                      >
                        <Choice
                          label={label()}
                          value={props.draft.values()[field().name] ?? null}
                          items={enums().map((value) => ({
                            value,
                            title: value,
                          }))}
                          onChange={(value) => write(field().name, value ?? "")}
                        />
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
                      <If when={property().description}>
                        <Hint>{property().description}</Hint>
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
