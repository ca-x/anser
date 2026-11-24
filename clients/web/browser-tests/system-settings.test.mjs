import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium } from "playwright-core";

test("collapsible navigation, persisted retention and responsive account actions", async (t) => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || undefined });
  t.after(() => browser.close());
  const page = await browser.newPage({ locale: "en", viewport: { width: 1320, height: 900 } });
  page.setDefaultTimeout(6000);
  const site = "https://anser.test";
  const dist = new URL("../dist/", import.meta.url);
  let history = { enabled: true, days: 30 };
  let account = { id: "office", name: "Office", channel: "ntfy", enabled: true, tags: [], priority: 0, weight: 1 };
  await page.route(site + "/**", (route) => {
    const { pathname } = new URL(route.request().url());
    const prefix = "/assets/anser/";
    if (pathname.startsWith("/admin")) return route.fulfill({ path: fileURLToPath(new URL("index.html", dist)) });
    if (pathname.startsWith(prefix)) return route.fulfill({ path: fileURLToPath(new URL(pathname.slice(prefix.length), dist)) });
    if (pathname === "/v1/auth/me") return route.fulfill({ json: { id: "admin", username: "admin", admin: true, enabled: true } });
    if (pathname === "/v1/settings/history-retention") {
      if (route.request().method() === "PUT") history = route.request().postDataJSON();
      return route.fulfill({ json: history });
    }
    if (pathname === "/v1/accounts") return route.fulfill({ json: { items: [account] } });
    if (pathname === "/v1/channels") return route.fulfill({ json: { items: [{ id: "ntfy", display_name: "ntfy", available: true, enabled: true, config_schema: {} }] } });
    if (pathname === "/v1/accounts/office") {
      account = { ...account, ...route.request().postDataJSON() };
      return route.fulfill({ json: account });
    }
    return route.fulfill({ json: { items: [] } });
  });
  await page.addInitScript(() => sessionStorage.setItem("anser.auth.session", "test-session"));
  await page.goto(site + "/admin/accounts");
  const nav = page.locator("nav.sidebar");
  const system = nav.locator("summary").filter({ hasText: "Administration" });
  const settingsLink = nav.getByRole("link", { name: "System settings" });
  await settingsLink.waitFor();
  await system.press("Enter");
  await settingsLink.waitFor({ state: "hidden" });
  await system.press("Enter");
  await settingsLink.click();
  await page.getByRole("heading", { name: "System settings", exact: true }).waitFor();
  await page.getByRole("switch", { name: "Automatically clean up delivery history" }).uncheck();
  await page.getByLabel("Delivery history retention (days)").fill("45");
  await page.getByRole("button", { name: "Save settings" }).click();
  await page.getByText("Settings saved.", { exact: true }).waitFor();
  assert.deepEqual(history, { enabled: false, days: 45 });
  await page.reload();
  const cleanup = page.getByRole("switch", { name: "Automatically clean up delivery history" });
  await cleanup.waitFor();
  assert.equal(await cleanup.isChecked(), false);
  assert.equal(await page.getByLabel("Delivery history retention (days)").inputValue(), "45");
  await page.goto(site + "/admin/accounts");
  const edit = page.getByRole("row", { name: /Office/ }).getByRole("button", { name: "Edit account" });
  await edit.hover();
  assert.equal((await edit.innerText()).trim(), "");
  await page.getByRole("tooltip").getByText("Edit account", { exact: true }).waitFor();
  await edit.click();
  await page.getByRole("dialog").getByLabel("Account name").fill("Office alerts");
  await page.getByRole("button", { name: "Save account" }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  const saved = page.getByRole("row", { name: /Office alerts/ }).getByRole("button", { name: "Edit account" });
  await page.setViewportSize({ width: 390, height: 800 });
  await saved.waitFor();
  assert.equal((await saved.innerText()).trim(), "Edit account");
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
});
