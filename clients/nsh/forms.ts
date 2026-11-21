import { t } from "nsh/i18n";
import { ApiError } from "./api";
import type { JsonObject, Target } from "./contracts";

export function tagsFrom(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[,，\n]/)
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}

export function parseObject(text: string, label: string): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ApiError(
      "invalid_json",
      t("forms.invalid_json", { field: label }),
    );
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ApiError(
      "invalid_json",
      t("forms.expected_json_object", { field: label }),
    );
  }
  return value as JsonObject;
}

export function integer(text: string, label: string, min: number, max: number) {
  const value = Number(text);
  if (
    !text.trim() ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new ApiError(
      "invalid_number",
      t("forms.integer_range", { field: label, min: min, max: max }),
    );
  }
  return value;
}

export function optionalHttpUrl(
  text: string,
  label: string,
): string | undefined {
  if (!text.trim()) return undefined;
  try {
    const url = new URL(text.trim());
    if (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    )
      return url.href;
  } catch {
    // Present the same field error for every malformed URL.
  }
  throw new ApiError(
    "invalid_url",
    t("forms.invalid_http_url", { field: label }),
  );
}

export function selectorTitle(
  target: Target,
  accountName: string | undefined,
  channelName: string | undefined,
) {
  return (
    [
      accountName ?? target.account_id,
      channelName ?? target.channel,
      target.tag_selector?.join("、"),
    ]
      .filter(Boolean)
      .join(" / ") || t("forms.all_accounts")
  );
}
