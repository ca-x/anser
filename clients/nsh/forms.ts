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
    throw new ApiError("invalid_json", `${label}应为有效的 JSON。`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ApiError("invalid_json", `${label}应为 JSON 对象。`);
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
      `${label}应为 ${min} 至 ${max} 之间的整数。`,
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
    `${label}应为不含凭据的 HTTP 或 HTTPS URL。`,
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
      .join(" / ") || "全部账号"
  );
}
