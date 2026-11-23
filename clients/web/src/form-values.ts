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

export interface DeviceTarget { user_id: string; device_id: string }

export function currentDevice(directory: LazycatDevices | undefined, target: DeviceTarget | undefined) {
  if (!target || directory?.user_id !== target.user_id) return undefined;
  return directory.devices.find((device) => device.device_id === target.device_id);
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
