import type { Account, Channel, JsonObject, LazycatDevices } from "./api";

export function split(value: string) {
  return [...new Set(value.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean))];
}

export function serializeConfig(channel: Channel, value: JsonObject) {
  const fields = channel.config_schema.properties as Record<string, { type?: string }> | undefined;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "proxy").map(([key, entry]) => [
    key, fields?.[key]?.type === "array" && typeof entry === "string"
      ? split(entry) : entry,
  ]));
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
