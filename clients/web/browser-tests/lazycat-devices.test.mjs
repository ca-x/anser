import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium } from "playwright-core";

test("saves a LazyCat device group and preselects its devices when editing", async (t) => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || undefined });
  t.after(() => browser.close());
  const page = await browser.newPage({ locale: "en", viewport: { width: 390, height: 844 } });
  const site = "https://anser.test";
  const dist = new URL("../dist/", import.meta.url);
  const user_id = "trusted-owner";
  const devices = [
    { device_id: "phone", name: "Phone", online: true },
    { device_id: "laptop", name: "Laptop", online: false },
  ];
  let saved;
  let config;
  await page.route(site + "/**", (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === "/admin/accounts") return route.fulfill({ path: fileURLToPath(new URL("index.html", dist)) });
    const prefix = "/assets/anser/";
    if (path.startsWith(prefix)) return route.fulfill({ path: fileURLToPath(new URL(path.slice(prefix.length), dist)) });
    if (path === "/v1/auth/me") return route.fulfill({ json: { id: "admin", username: "editor", admin: true, enabled: true } });
    if (path === "/v1/channels") return route.fulfill({ json: { items: [{
      id: "lazycat", display_name: "LazyCat", config_schema: {},
      capabilities: { formats: ["text"], attachments: false, user_target: true },
    }] } });
    if (path === "/v1/channels/lazycat/devices") {
      return route.fulfill({ json: { user_id, devices, max_selection: 16,
        configured_device_ids: url.searchParams.get("account_id") === "group" ? config.device_ids : undefined } });
    }
    if (path === "/v1/accounts" && route.request().method() === "POST") {
      const { config: destination, ...account } = route.request().postDataJSON();
      config = destination;
      saved = { id: "group", ...account };
      return route.fulfill({ status: 201, json: saved });
    }
    if (path === "/v1/accounts/group" && route.request().method() === "PUT") {
      config = route.request().postDataJSON().config;
      return route.fulfill({ json: saved });
    }
    return route.fulfill({ json: { items: saved ? [saved] : [] } });
  });
  await page.addInitScript(() => sessionStorage.setItem("anser.auth.session", "fixture"));
  await page.goto(site + "/admin/accounts");
  await page.getByRole("button", { name: "Add account" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Account name").fill("Home");
  const phone = dialog.getByRole("checkbox", { name: /Phone/ });
  const laptop = dialog.getByRole("checkbox", { name: /Laptop/ });
  await phone.check();
  await laptop.check();
  assert.equal(await dialog.locator('.device-status-dot[data-online="true"]').count(), 1);
  assert.equal(await dialog.locator('.device-status-dot[data-online="false"]').count(), 1);
  await dialog.getByRole("button", { name: "Save account" }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.deepEqual(config, { user_id, device_ids: ["phone", "laptop"] });
  await page.getByRole("button", { name: "Home" }).click();
  await dialog.getByText("2 selected", { exact: false }).waitFor();
  assert.ok(await phone.isChecked());
  assert.ok(await laptop.isChecked());
  await laptop.uncheck();
  await dialog.getByRole("button", { name: "Save account" }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.deepEqual(config, { user_id, device_id: "phone" });
});
