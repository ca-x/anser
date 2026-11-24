import assert from "node:assert/strict";
import test from "node:test";
import type { Account, Channel } from "../src/api.ts";
import { currentDevices, initialProxyChoice, proxySettings, serializeConfig, serializeDeviceTarget } from "../src/form-values.ts";

const account: Account = { id: "phone", name: "Phone", channel: "ntfy", priority: 0, weight: 1, tags: [], enabled: true };

test("new accounts can connect directly or select a stored profile", () => {
  assert.equal(initialProxyChoice(), "direct");
  assert.deepEqual(proxySettings("direct"), {});
  assert.deepEqual(proxySettings("profile:office"), { proxy_id: "office" });
});

test("editing an existing connection preserves encrypted settings until direct connection is explicitly selected", () => {
  assert.equal(initialProxyChoice(account), "keep");
  assert.deepEqual(proxySettings("keep", account), { inline_proxy: "keep" });
  const shared = { ...account, proxy_id: "office" };
  assert.equal(initialProxyChoice(shared), "profile:office");
  assert.deepEqual(proxySettings("profile:office", shared), { inline_proxy: "keep" });
  assert.deepEqual(proxySettings("profile:other", shared), { proxy_id: "other", inline_proxy: "keep" });
  assert.deepEqual(proxySettings("direct", shared), { proxy_id: null, inline_proxy: "clear" });
  assert.deepEqual(proxySettings("direct", account), { proxy_id: null, inline_proxy: "clear" });
});

test("channel forms never serialize inline proxy credentials when replacing a configuration", () => {
  const channel: Channel = { id: "bark", display_name: "Bark", config_schema: { properties: { device_keys: { type: "array" }, proxy: { type: "string" } } },
    capabilities: { attachments: false, user_target: true, formats: ["text"] } };
  assert.deepEqual(serializeConfig(channel, { proxy: "fixture-proxy", device_keys: "one, two，one", group: "ops" }),
    { device_keys: ["one", "two"], group: "ops" });
});

test("device selections belong to their discovered LazyCat identity and remain selectable offline", () => {
  const home = { user_id: "alice", max_selection: 16, devices: [
    { device_id: "phone", name: "Phone", online: false },
    { device_id: "laptop", name: "Laptop", online: true },
  ] };
  const selected = { user_id: "alice", device_ids: ["phone", "laptop"] };
  assert.equal(currentDevices(home, selected), true);
  assert.equal(currentDevices({ ...home, max_selection: undefined }, selected), false);
  assert.equal(currentDevices({ ...home, user_id: "bob" }, selected), false);
  assert.equal(currentDevices({ ...home, devices: home.devices.slice(0, 1) }, selected), false);
  assert.equal(currentDevices(undefined, selected), false);
  assert.equal(currentDevices(home, undefined), false);
  assert.deepEqual(serializeDeviceTarget(selected), selected);
  assert.deepEqual(serializeDeviceTarget({ ...selected, device_ids: ["phone"] }), { user_id: "alice", device_id: "phone" });
});

test("plugin metadata excludes inactive configuration fields and uses default discriminator values", () => {
  const plugin = { id: "fixture", config_schema: { properties: {
    mode: { type: "string", default: "a" },
    hidden_secret: { type: "string", writeOnly: true, "x-anser-ui": { visible_when: { field: "mode", equals: "b" } } },
    options: { type: "object", "x-anser-ui": { visible_when: { field: "mode", equals: "a" } } },
  } } };
  assert.deepEqual(serializeConfig(plugin, { hidden_secret: "fixture", options: '{"timeout": 2}' }),
    { options: { timeout: 2 } });
  assert.deepEqual(serializeConfig(plugin, { mode: "b", hidden_secret: "fixture", options: '{"timeout": 2}' }),
    { mode: "b", hidden_secret: "fixture" });
});
