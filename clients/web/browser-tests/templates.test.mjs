import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium } from "playwright-core";

test("creates a template and publishes a topic notification with only template variables", async (t) => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || undefined });
  t.after(() => browser.close());
  const page = await browser.newPage({ locale: "en", viewport: { width: 390, height: 844 }, colorScheme: "dark" });
  page.setDefaultTimeout(5_000);
  const url = "https://anser.test";
  const dist = new URL("../dist/", import.meta.url);
  const list = [{
    id: "builtin.deployment", name: "builtin.deployment", title: "Deployed {{service}}", body: "",
    format: "text", variables: ["service"], shared: true, builtin: true, can_edit: false,
  }];
  let created, submitted, key, edited;
  await page.route(url + "/**", (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path.startsWith("/admin")) return route.fulfill({ path: fileURLToPath(new URL("index.html", dist)) });
    const prefix = "/assets/anser/";
    if (path.startsWith(prefix)) return route.fulfill({ path: fileURLToPath(new URL(path.slice(prefix.length), dist)) });
    if (path === "/v1/auth/me") return route.fulfill({ json: { id: "1", username: "editor", admin: true, enabled: true } });
    if (path === "/v1/templates" && req.method() === "POST") {
      created = req.postDataJSON();
      const id = created.name === "release" ? "custom" : "copy";
      const template = { ...created, id, variables: ["service", "version"], builtin: false, can_edit: true };
      list.push(template);
      return route.fulfill({ status: 201, json: template });
    }
    if (path === "/v1/templates") return route.fulfill({ json: { items: list } });
    if (path === "/v1/templates/custom") {
      if (req.method() === "PUT") {
        edited = req.postDataJSON();
        Object.assign(list.find(({ id }) => id === "custom"), edited);
      }
      return route.fulfill({ json: list.find(({ id }) => id === "custom") });
    }
    if (path === "/v1/topics") return route.fulfill({ json: { items: [{ name: "alerts", enabled: true }] } });
    if (path === "/v1/topics/alerts/publish") {
      submitted = req.postDataJSON();
      key = req.headers()["idempotency-key"];
      return route.fulfill({ status: 202, json: { message_id: "template-message", status: "pending" } });
    }
    if (path === "/v1/messages/template-message") return route.fulfill({ json: {
      id: "template-message", topic: "alerts", status: "pending", message: { title: "Anser released", body: "1.2.3", format: "text" },
      created_at: 1750000000000, inbox_deliveries: 0, deliveries: [],
    } });
    return route.fulfill({ json: { items: [] } });
  });
  await page.addInitScript(() => sessionStorage.setItem("anser.auth.session", "test-session"));
  await page.goto(url + "/admin/templates");
  await page.getByRole("heading", { name: "Notification templates" }).waitFor();
  await page.getByText("Deployment complete", { exact: true }).first().waitFor();
  const builtInRow = page.getByRole("row", { name: /Deployment complete/ });
  assert.equal(await builtInRow.getByRole("button", { name: "Edit", exact: true }).count(), 0);
  await page.getByRole("button", { name: "Create template", exact: true }).click();
  await page.getByLabel("Template name").fill("release");
  await page.getByLabel("Title", { exact: true }).fill("{{service}} released");
  await page.getByLabel("Body", { exact: true }).fill("{{version}}");
  await page.getByLabel("Share template").check();
  await page.getByRole("button", { name: "Save template", exact: true }).click();
  assert.deepEqual(created, { name: "release", title: "{{service}} released", body: "{{version}}", format: "text", shared: true });
  const row = page.getByRole("row", { name: /release/ });
  await row.getByRole("button", { name: "Edit template" }).click();
  await page.getByLabel("Title", { exact: true }).fill("Release of {{service}}");
  await page.getByRole("button", { name: "Save template", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(edited.title, "Release of {{service}}");

  await builtInRow.getByRole("button", { name: "Duplicate and edit", exact: true }).click();
  assert.equal(await page.getByLabel("Title", { exact: true }).inputValue(), "Deployed {{service}}");
  assert.equal(await page.getByLabel("Share template").isChecked(), false);
  await page.getByLabel("Template name").fill("deployment-copy");
  await page.getByRole("button", { name: "Save template", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.getByRole("row", { name: /deployment-copy/ }).waitFor();

  await page.getByRole("row", { name: /release/ }).getByRole("button", { name: "Use template", exact: true }).click();
  await page.getByRole("heading", { name: "Send notification", exact: true }).waitFor();
  await page.getByLabel("Send to", { exact: true }).selectOption("topic:alerts");
  assert.equal(await page.getByLabel("Choose template").inputValue(), "custom");
  await page.getByLabel("service", { exact: true }).fill("Anser");
  await page.getByLabel("version", { exact: true }).fill("1.2.3");
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  await page.getByRole("button", { name: "Send notification", exact: true }).click();
  await page.waitForURL("**/admin/messages/template-message");
  assert.deepEqual(submitted, { template_id: "custom", variables: { service: "Anser", version: "1.2.3" }, tags: [] });
  assert.match(key, /^[a-f0-9]{40}$/);
  await page.evaluate(() => localStorage.setItem("anser.ui.language", "zh-CN"));
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1240, height: 820 });
  await page.goto(url + "/admin/templates");
  await page.getByRole("heading", { name: "通知模板", exact: true }).waitFor();
  await page.getByText("部署完成", { exact: true }).first().waitFor();
  assert.equal(await page.getByText("Deployment complete", { exact: true }).count(), 0);
  assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
});
