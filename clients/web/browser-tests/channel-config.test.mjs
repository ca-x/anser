import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium } from "playwright-core";

test("account forms send numeric channel options as numbers and preserve explicit booleans", async (t) => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || undefined });
  t.after(() => browser.close());
  const page = await browser.newPage({ locale: "zh-CN" });
  const site = "https://anser.test";
  const dist = new URL("../dist/", import.meta.url);
  const channel = {
    id: "chanify", display_name: "Chanify", enabled: true, available: true, can_manage: true,
    config_schema: { properties: {
      token: { type: "string", writeOnly: true },
      sound: { type: "boolean", default: false },
      priority: { type: "integer", enum: [5, 10], default: 10 },
    }, required: ["token"] },
  };
  let payload;
  await page.route(site + "/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith("/admin")) return route.fulfill({ path: fileURLToPath(new URL("index.html", dist)) });
    const prefix = "/assets/anser/";
    if (path.startsWith(prefix)) return route.fulfill({ path: fileURLToPath(new URL(path.slice(prefix.length), dist)) });
    if (path === "/v1/auth/me") return route.fulfill({ json: { id: "1", username: "editor", admin: true, enabled: true } });
    if (path === "/v1/channels/chanify") return route.fulfill({ json: channel });
    if (path === "/v1/accounts" && route.request().method() === "POST") {
      payload = route.request().postDataJSON();
      return route.fulfill({ status: 201, json: { ...payload, id: "1" } });
    }
    return route.fulfill({ json: { items: [] } });
  });
  await page.addInitScript(() => sessionStorage.setItem("anser.auth.session", "test-session"));
  await page.goto(site + "/admin/channels/chanify");
  await page.getByRole("button", { name: "新增账号", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("账号名称", { exact: true }).fill("测试设备");
  await dialog.getByLabel("令牌", { exact: true }).fill("sample");
  await dialog.getByRole("combobox", { name: "优先级", exact: true }).selectOption("5");
  await dialog.getByRole("combobox", { name: "提示音", exact: true }).selectOption("false");
  await dialog.getByRole("button", { name: "保存账号" }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.deepEqual(payload.config, { token: "sample", sound: false, priority: 5 });
});
