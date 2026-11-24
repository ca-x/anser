import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium } from "playwright-core";

test("copies the MCP address and creates, rotates and disables scoped tokens", async (t) => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || undefined });
  t.after(() => browser.close());
  const context = await browser.newContext({ locale: "en", permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  page.setDefaultTimeout(6_000);
  const site = "https://anser.test";
  const dist = new URL("../dist/", import.meta.url);
  const key = { id: "key", name: "Editor agent", scopes: ["interact"], enabled: true };
  let issued = false;
  await page.route(site + "/**", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const asset = "/assets/anser/";
    if (url.pathname.startsWith("/admin")) return route.fulfill({ path: fileURLToPath(new URL("index.html", dist)) });
    if (url.pathname.startsWith(asset)) return route.fulfill({ path: fileURLToPath(new URL(url.pathname.slice(asset.length), dist)) });
    if (url.pathname === "/v1/auth/me") return route.fulfill({ json: { id: "admin", username: "admin", admin: true, enabled: true } });
    if (url.pathname === "/v1/settings/mcp") return route.fulfill({ json: { endpoint: site + "/mcp" } });
    if (url.pathname === "/v1/api-keys" && request.method() === "GET") {
      assert.equal(url.searchParams.get("scope"), "interact");
      return route.fulfill({ json: { items: issued ? [key] : [] } });
    }
    if (url.pathname === "/v1/api-keys" && request.method() === "POST") {
      assert.deepEqual(request.postDataJSON(), { name: key.name, scopes: ["interact"] });
      issued = true;
      return route.fulfill({ status: 201, json: { token: "test-first-token", key } });
    }
    if (url.pathname === "/v1/api-keys/key/rotate") return route.fulfill({ json: { token: "test-rotated-token", key } });
    if (url.pathname === "/v1/api-keys/key" && request.method() === "DELETE") {
      key.enabled = false;
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ json: { items: [] } });
  });
  await page.addInitScript(() => sessionStorage.setItem("anser.auth.session", "test-session"));
  await page.goto(site + "/admin/mcp");
  await page.getByRole("button", { name: "Copy MCP address" }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), site + "/mcp");
  await page.getByRole("button", { name: "Create MCP token" }).click();
  await page.getByLabel("Key name").fill(key.name);
  await page.getByRole("button", { name: "Generate key" }).click();
  const drawer = page.getByRole("dialog");
  await drawer.getByText("test-first-token").waitFor();
  await drawer.getByRole("button", { name: "Done" }).click();
  const row = page.getByRole("row", { name: /Editor agent/ });
  await row.getByRole("button", { name: "Rotate", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Rotate key" }).click();
  await drawer.getByText("test-rotated-token").waitFor();
  await drawer.getByRole("button", { name: "Done" }).click();
  await row.getByRole("button", { name: "Disable key", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Disable key" }).click();
  await row.getByText("Disabled", { exact: true }).waitFor();
  assert.equal(await row.getByRole("button", { name: "Rotate", exact: true }).count(), 0);
});
