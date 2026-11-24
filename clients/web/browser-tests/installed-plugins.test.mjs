import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium } from "playwright-core";

test("groups installed plugins by capability and renders website list options supplied by a task", async (t) => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || undefined });
  t.after(() => browser.close());
  const page = await browser.newPage({ locale: "en", colorScheme: "dark", viewport: { width: 390, height: 800 } });
  page.setDefaultTimeout(7500);
  const site = "https://anser.test";
  const dist = new URL("../dist/", import.meta.url);
  const installed = [
    { id: "ntfy", kind: "channel", display_name: "ntfy", available: true, enabled: true, config_schema: {} },
    {
      id: "certificate-expiration", kind: "task", display_name: "Not the localized name", available: true, enabled: true,
      config_schema: {
        "x-anser-ui": { label: { en: "TLS certificate expiration", "zh-CN": "网站证书到期检查" }, task_input: "none" },
        properties: {
          urls: { type: "array", items: { type: "string" }, "x-anser-ui": { label: { en: "Website URLs" } } },
          warning_days: { type: "integer", default: 30, "x-anser-ui": { label: { en: "Warning days" } } },
        },
        required: ["urls"],
      },
    },
    { id: "openai-tts", kind: "content_transform", display_name: "OpenAI TTS", available: true, enabled: true, config_schema: {} },
  ];
  let payload;
  await page.route(site + "/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith("/admin")) return route.fulfill({ path: fileURLToPath(new URL("index.html", dist)) });
    const asset = "/assets/anser/";
    if (path.startsWith(asset)) return route.fulfill({ path: fileURLToPath(new URL(path.slice(asset.length), dist)) });
    if (path === "/v1/auth/me") return route.fulfill({ json: { id: "admin", username: "admin", admin: true, enabled: true } });
    if (path === "/v1/plugins") return route.fulfill({ json: { items: installed } });
    if (path === "/v1/plugins/task/certificate-expiration/run") {
      payload = route.request().postDataJSON();
      return route.fulfill({ json: {
        notifications: [{ title: "Certificate warning", body: "One site expires soon." }],
        details: { websites: [{ status: "healthy" }, { status: "expiring" }] },
      } });
    }
    return route.fulfill({ json: { items: [] } });
  });
  await page.addInitScript(() => sessionStorage.setItem("anser.auth.session", "test-session"));
  await page.goto(site + "/admin/channels");
  for (const group of ["Channel plugins", "Task plugins", "Content transforms"]) {
    await page.getByRole("heading", { name: group, exact: true }).waitFor();
  }
  assert.equal(await page.getByText("Not the localized name", { exact: true }).count(), 0);
  await page.getByRole("button", { name: "Run TLS certificate expiration" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Website URLs").fill("https://example.com, https://example.org");
  await dialog.getByLabel("Warning days").fill("14");
  await dialog.getByRole("button", { name: "Run plugin", exact: true }).click();
  await dialog.getByText("Certificate warning", { exact: true }).waitFor();
  assert.deepEqual(payload.config, { urls: ["https://example.com", "https://example.org"], warning_days: 14 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
});
