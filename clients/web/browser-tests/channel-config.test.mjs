import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium } from "playwright-core";

test("account forms send numeric channel options as numbers and preserve explicit booleans", async (t) => {
  const { page, payload } = await accountForm(t, {
    id: "chanify",
    config_schema: { properties: {
      token: { type: "string", writeOnly: true },
      sound: { type: "boolean", default: false },
      priority: { type: "integer", enum: [5, 10], default: 10 },
    }, required: ["token"] },
  });
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("账号名称", { exact: true }).fill("测试设备");
  await dialog.getByLabel("令牌", { exact: true }).fill("sample");
  await dialog.getByRole("combobox", { name: "优先级", exact: true }).selectOption("5");
  await dialog.getByRole("combobox", { name: "提示音", exact: true }).selectOption("false");
  await dialog.getByRole("button", { name: "保存账号" }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.deepEqual(payload().config, { token: "sample", sound: false, priority: 5 });
});

test("switching mail providers clears the previous password and saves the chosen style and display name", async (t) => {
  const { page, payload } = await accountForm(t, {
    id: "email",
    config_schema: {
      "x-anser-ui": { presets: [
        { id: "qq", label: { "zh-CN": "QQ 邮箱" }, values: { host: "smtp.qq.com", port: 465, encryption: "tls" } },
        { id: "icloud", label: { "zh-CN": "iCloud 邮件" }, values: { host: "smtp.mail.me.com", port: 587, encryption: "starttls", password: "ignored" } },
      ] },
      properties: {
        host: { type: "string" }, port: { type: "integer" },
        encryption: { type: "string", enum: ["tls", "starttls"] },
        password: { type: "string", writeOnly: true }, username: { type: "string" },
        from: { type: "string" }, to: { type: "array" },
        from_name: { type: "string", "x-anser-ui": { label: { "zh-CN": "发件人显示名称" } } },
        email_style: { type: "string", enum: ["styled", "plain"], default: "styled", "x-anser-ui": {
          label: { "zh-CN": "邮件样式" }, option_labels: { plain: { "zh-CN": "纯文本" } },
        } },
      },
      required: ["host", "from", "to"],
    },
  });
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("账号名称", { exact: true }).fill("提醒邮件");
  const preset = dialog.getByRole("combobox", { name: "连接预设" });
  await preset.selectOption("qq");
  assert.equal(await dialog.getByLabel("主机", { exact: true }).inputValue(), "smtp.qq.com");
  const password = dialog.getByLabel("密码", { exact: true });
  await password.fill("previous-fixture");
  await preset.selectOption("icloud");
  assert.equal(await password.inputValue(), "");
  await password.fill("current-fixture");
  await dialog.getByLabel("用户名", { exact: true }).fill("sender@example.com");
  await dialog.getByLabel("发件地址", { exact: true }).fill("sender@example.com");
  await dialog.getByLabel("收件地址", { exact: true }).fill("operator@example.com");
  await dialog.getByLabel("发件人显示名称", { exact: true }).fill("雁字提醒");
  await dialog.getByRole("combobox", { name: "邮件样式" }).selectOption({ label: "纯文本" });
  await dialog.getByRole("button", { name: "保存账号" }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.deepEqual(payload().config, {
    host: "smtp.mail.me.com", port: 587, encryption: "starttls", password: "current-fixture",
    username: "sender@example.com", from: "sender@example.com", to: ["operator@example.com"],
    from_name: "雁字提醒", email_style: "plain",
  });
});

test("editing a configured account opens its plugin form and preserves the write-only credential", async (t) => {
  const config = { host: "smtp.qq.com", from: "sender@example.com", to: ["reader@example.com"] };
  const { page, payload } = await accountForm(t, {
    id: "email",
    existingConfig: config,
    config_schema: {
      "x-anser-ui": { account_editor: { fields: ["host", "from", "to", "from_name"] } },
      properties: {
        host: { type: "string" }, from: { type: "string" }, to: { type: "array" },
        password: { type: "string", writeOnly: true },
        from_name: { type: "string", "x-anser-ui": { label: { "zh-CN": "发件人显示名称" } } },
      },
      required: ["host", "from", "to", "password"],
    },
  });
  const dialog = page.getByRole("dialog");
  assert.equal(await dialog.getByLabel("主机", { exact: true }).inputValue(), "smtp.qq.com");
  assert.equal(await dialog.getByLabel("密码", { exact: true }).inputValue(), "");
  assert.equal(await dialog.getByText("替换渠道配置").count(), 0);
  await dialog.getByLabel("发件人显示名称").fill("雁字提醒");
  await dialog.getByRole("button", { name: "保存账号" }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.deepEqual(payload().config, { ...config, from_name: "雁字提醒" });
  assert.equal(payload().config_revision, "fixture-revision");
});

test("ServerChan links come from plugin metadata and extra delivery options are absent", async (t) => {
  const { page } = await accountForm(t, {
    id: "serverchan",
    config_schema: {
      "x-anser-ui": { form_fields: ["sendkey"] },
      properties: {
        sendkey: { type: "string", writeOnly: true, "x-anser-ui": { links: [
          { label: { "zh-CN": "申请 Turbo SendKey" }, url: "https://sct.ftqq.com/sendkey" },
          { label: { "zh-CN": "申请 Server酱³ SendKey" }, url: "https://sc3.ft07.com/sendkey" },
        ] } },
        version: { type: "string", enum: ["turbo", "3"] },
      },
      required: ["sendkey"],
    },
  });
  const dialog = page.getByRole("dialog");
  assert.equal(await dialog.getByRole("link", { name: "申请 Turbo SendKey" }).getAttribute("href"), "https://sct.ftqq.com/sendkey");
  assert.equal(await dialog.getByRole("link", { name: "申请 Server酱³ SendKey" }).getAttribute("href"), "https://sc3.ft07.com/sendkey");
  assert.equal(await dialog.getByLabel("version", { exact: true }).count(), 0);
});

async function accountForm(t, { id, config_schema, existingConfig }) {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || undefined });
  t.after(() => browser.close());
  const page = await browser.newPage({ locale: "zh-CN" });
  const site = "https://anser.test";
  const dist = new URL("../dist/", import.meta.url);
  const channel = {
    id, display_name: id, enabled: true, available: true, can_manage: true, config_schema,
  };
  const account = { id: "1", name: "Existing", channel: id, weight: 1, priority: 0, enabled: true, tags: [] };
  let payload;
  await page.route(site + "/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith("/admin")) return route.fulfill({ path: fileURLToPath(new URL("index.html", dist)) });
    const prefix = "/assets/anser/";
    if (path.startsWith(prefix)) return route.fulfill({ path: fileURLToPath(new URL(path.slice(prefix.length), dist)) });
    if (path === "/v1/auth/me") return route.fulfill({ json: { id: "1", username: "editor", admin: true, enabled: true } });
    if (path === `/v1/channels/${id}`) return route.fulfill({ json: channel });
    if (path === "/v1/accounts/1/config") return route.fulfill({
      json: { config: existingConfig, saved_credentials: ["password"], revision: "fixture-revision" },
    });
    if (path === "/v1/accounts/1" && route.request().method() === "PUT") {
      payload = route.request().postDataJSON();
      return route.fulfill({ json: { ...account, ...payload } });
    }
    if (path === "/v1/accounts" && route.request().method() === "POST") {
      payload = route.request().postDataJSON();
      return route.fulfill({ status: 201, json: { ...payload, id: "1" } });
    }
    return route.fulfill({ json: { items: existingConfig && path === "/v1/accounts" ? [account] : [] } });
  });
  await page.addInitScript(() => sessionStorage.setItem("anser.auth.session", "test-session"));
  await page.goto(site + `/admin/channels/${id}`);
  await page.getByRole("button", { name: existingConfig ? "编辑账号" : "新增账号", exact: true }).first().click();
  return { page, payload: () => payload };
}
