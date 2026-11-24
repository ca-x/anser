import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium } from "playwright-core";

test("on narrow screens, publish and filter plugin announcements from plugin management", async (t) => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || undefined });
  t.after(() => browser.close());
  const page = await browser.newPage({
    locale: "en", viewport: { width: 390, height: 800 }, colorScheme: "dark", reducedMotion: "reduce",
  });
  page.setDefaultTimeout(7_500);
  const site = "https://anser.test";
  const dist = new URL("../dist/", import.meta.url);
  const listings = [];
  await page.route(site + "/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path.startsWith("/admin")) return route.fulfill({ path: fileURLToPath(new URL("index.html", dist)) });
    const prefix = "/assets/anser/";
    if (path.startsWith(prefix)) return route.fulfill({ path: fileURLToPath(new URL(path.slice(prefix.length), dist)) });
    if (path === "/v1/auth/me") {
      return route.fulfill({ json: { id: "editor", username: "editor", admin: true, enabled: true } });
    }
    if (path === "/v1/plugins/market") {
      const q = url.searchParams.get("q");
      return route.fulfill({ json: { items: q === "weather" ? [
        { full_name: "example/anser-weather", description: "Weather for Anser", stargazers_count: 5 },
      ] : [], next_cursor: null } });
    }
    if (path === "/v1/topics") {
      return route.fulfill({ json: { items: [{ name: "plugin-news", enabled: true, policy: { mode: "broadcast" } }], next_cursor: null } });
    }
    if (path === "/v1/topics/plugin-news/plugin-listings") {
      if (request.method() === "POST") {
        const manifest = request.postDataJSON();
        listings.push({ message_id: "release-1", created_at: 1_700_000_000_000, manifest });
        return route.fulfill({ status: 202, json: { message_id: "release-1", status: "success" } });
      }
      const kind = url.searchParams.get("kind");
      return route.fulfill({ json: { items: listings.filter(({ manifest }) => !kind || manifest.kind === kind), next_cursor: null } });
    }
    return route.fulfill({ json: { items: [], next_cursor: null } });
  });
  await page.addInitScript(() => sessionStorage.setItem("anser.auth.session", "test-session"));
  await page.goto(site + "/admin/topics");
  assert.equal(await page.getByRole("button", { name: "Plugin marketplace" }).count(), 0);
  await page.goto(site + "/admin/channels");
  await page.getByRole("tab", { name: "Plugin marketplace" }).click();
  await page.getByRole("heading", { name: "Discover plugins on GitHub" }).waitFor();
  await page.getByLabel("Search GitHub plugins").fill("weather");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  assert.equal(await page.getByRole("link", { name: /example\/anser-weather/ }).getAttribute("href"),
    "https://github.com/example/anser-weather");
  assert.match(page.url(), /channels\/market$/);
  await page.getByRole("button", { name: "Topic announcements" }).click();
  await page.getByRole("combobox", { name: "Catalog topic" }).selectOption("plugin-news");
  await page.getByRole("button", { name: "Publish plugin listing" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name", { exact: true }).fill("Certificate monitor");
  await dialog.getByLabel("Plugin ID").fill("org.example.cert-monitor");
  await dialog.getByLabel("Version").fill("1.2.3");
  await dialog.getByLabel("Plugin type").selectOption("task");
  await dialog.getByLabel("Description").fill("Warn before a certificate expires.");
  await dialog.getByLabel("Source repository or release link").fill("https://example.com/plugins/cert-monitor");
  await dialog.getByRole("button", { name: "Publish listing", exact: true }).click();
  await page.getByText("Plugin listing published.", { exact: true }).waitFor();
  const listing = page.getByRole("button", { name: "Certificate monitor" });
  await listing.click();
  await dialog.getByText("org.example.cert-monitor", { exact: true }).waitFor();
  assert.equal(await dialog.getByRole("link", { name: "View source" }).getAttribute("href"),
    "https://example.com/plugins/cert-monitor");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await page.getByRole("combobox", { name: "Plugin type" }).selectOption("channel");
  await page.getByRole("heading", { name: "No listings for this plugin type" }).waitFor();
  assert.equal(listings.length, 1);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
});
