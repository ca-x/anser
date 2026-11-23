import assert from "node:assert/strict";
import test from "node:test";
import type { Account, Channel } from "../src/api.ts";
import { currentDevice, initialProxyChoice, proxySettings, serializeConfig } from "../src/form-values.ts";

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
  const home = { user_id: "alice", devices: [{ device_id: "phone", name: "Phone", online: false }] };
  const selected = { user_id: "alice", device_id: "phone" };
  assert.deepEqual(currentDevice(home, selected), home.devices[0]);
  assert.equal(currentDevice({ ...home, user_id: "bob" }, selected), undefined);
  assert.equal(currentDevice({ ...home, devices: [] }, selected), undefined);
  assert.equal(currentDevice(undefined, selected), undefined);
  assert.equal(currentDevice(home, undefined), undefined);
});
