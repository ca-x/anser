import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium } from "playwright-core";

test("groups installed plugins by capability and renders website list options supplied by a task", async (t) => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || undefined });
  t.after(() => browser.close());
  const page = await browser.newPage({ locale: "en", timezoneId: "Asia/Shanghai", colorScheme: "dark", viewport: { width: 390, height: 800 } });
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
  let schedule;
  let updated;
  const finishedSchedule = () => ({
    ...schedule, id: "test", enabled: false, completed: true, next_at: null,
    last_at: Date.now(), last_status: "success", last_count: 1,
  });
  await page.route(site + "/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith("/admin")) return route.fulfill({ path: fileURLToPath(new URL("index.html", dist)) });
    const asset = "/assets/anser/";
    if (path.startsWith(asset)) return route.fulfill({ path: fileURLToPath(new URL(path.slice(asset.length), dist)) });
    if (path === "/v1/auth/me") return route.fulfill({ json: { id: "admin", username: "admin", admin: true, enabled: true } });
    if (path === "/v1/plugins") return route.fulfill({ json: { items: installed } });
    if (path === "/v1/schedules") {
      if (route.request().method() === "POST") {
        schedule = route.request().postDataJSON();
        return route.fulfill({ status: 201, json: { id: "test" } });
      }
      const items = schedule?.rule.kind === "once" ? [finishedSchedule()] : [];
      return route.fulfill({ json: { items } });
    }
    if (path === "/v1/schedules/test") {
      if (route.request().method() === "PATCH") {
        updated = route.request().postDataJSON();
        schedule = { ...schedule, ...updated };
      }
      return route.fulfill({ json: finishedSchedule() });
    }
    if (path === "/v1/topics") return route.fulfill({ json: { items: [{ name: "alerts", enabled: true }] } });
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
  const filters = page.getByRole("group", { name: "Plugin type" });
  await filters.getByRole("button", { name: /Task plugins/ }).click();
  await page.getByRole("heading", { name: "TLS certificate expiration", exact: true }).waitFor();
  assert.equal(await page.getByRole("heading", { name: "OpenAI TTS", exact: true }).count(), 0);
  assert.equal(await page.getByText("Not the localized name", { exact: true }).count(), 0);
  await page.getByRole("button", { name: "Run TLS certificate expiration" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Website URLs").fill("https://example.com, https://example.org");
  await dialog.getByLabel("Warning days").fill("14");
  await dialog.getByRole("button", { name: "Run plugin", exact: true }).click();
  await dialog.getByText("Certificate warning", { exact: true }).waitFor();
  assert.deepEqual(payload.config, { urls: ["https://example.com", "https://example.org"], warning_days: 14 });
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await page.getByRole("link", { name: "Schedule a notification" }).click();
  await page.waitForURL("**/admin/schedules?plugin=certificate-expiration");
  await page.getByRole("heading", { name: "Scheduled tasks", exact: true }).waitFor();
  const fillSchedule = async (name) => {
    await dialog.getByLabel("Name", { exact: true }).fill(name);
    await dialog.getByLabel("Website URLs").fill("https://example.com");
    await dialog.getByLabel("Send to").selectOption("alerts");
  };
  const reopen = () => page.getByRole("button", { name: "Schedule a notification" }).click();
  const save = async () => {
    await dialog.getByRole("button", { name: "Save schedule" }).click();
    await dialog.waitFor({ state: "hidden" });
  };

  await fillSchedule("TLS reminders");
  await dialog.getByLabel("Interval", { exact: true }).fill("30");
  await save();
  assert.deepEqual(schedule, {
    name: "TLS reminders", plugin_id: "certificate-expiration", rule: { kind: "interval", minutes: 30 }, topic: "alerts",
    config: { urls: ["https://example.com"], warning_days: 30 }, input: null,
  });
  for (const [unit, minutes] of [["hours", 120], ["days", 2880]]) {
    await reopen();
    await fillSchedule("TLS reminders");
    await dialog.getByLabel("Interval", { exact: true }).fill("2");
    await dialog.getByLabel("Interval unit").selectOption(unit);
    await save();
    assert.deepEqual(schedule.rule, { kind: "interval", minutes });
  }

  await reopen();
  await fillSchedule("Weekly TLS check");
  await dialog.getByLabel("Schedule type").selectOption("weekly");
  await dialog.getByRole("button", { name: "Save schedule" }).click();
  await dialog.getByText("Select at least one day.", { exact: true }).waitFor();
  await dialog.getByRole("checkbox", { name: "Monday" }).check();
  await dialog.getByRole("checkbox", { name: "Sunday" }).check();
  await dialog.getByLabel("Time of day").fill("07:35");
  assert.equal(await dialog.getByLabel("Time zone").inputValue(), "Asia/Shanghai");
  await save();
  assert.deepEqual(schedule.rule, { kind: "weekly", weekdays: [1, 7], time: "07:35", time_zone: "Asia/Shanghai" });

  await reopen();
  await fillSchedule("One-time TLS check");
  await dialog.getByLabel("Schedule type").selectOption("once");
  const at = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 16);
  await dialog.getByLabel("Run date and time").fill(at);
  await save();
  assert.deepEqual(schedule.rule, { kind: "once", at: new Date(`${at}+08:00`).getTime() });
  const finished = page.getByRole("row").filter({ hasText: "One-time TLS check" });
  await finished.getByText("Finished", { exact: true }).waitFor();
  assert.ok(await finished.getByRole("button", { name: "Run now" }).isDisabled());
  assert.ok(await finished.getByRole("button", { name: "Resume" }).isDisabled());
  await finished.getByRole("button", { name: "Edit", exact: true }).click();
  assert.equal(await dialog.getByLabel("Website URLs").inputValue(), "https://example.com");
  assert.equal(await dialog.getByLabel("Run date and time").inputValue(), at);
  await dialog.getByLabel("Name", { exact: true }).fill("Renamed TLS check");
  await dialog.getByLabel("Warning days").fill("14");
  await save();
  assert.deepEqual(updated, {
    name: "Renamed TLS check", plugin_id: "certificate-expiration", topic: "alerts",
    config: { urls: ["https://example.com"], warning_days: 14 },
  });
  await page.getByRole("row", { name: /Renamed TLS check/ }).waitFor();

  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
});
