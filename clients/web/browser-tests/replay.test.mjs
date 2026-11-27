import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium } from "playwright-core";

test("review replay targets from the delivery list and detail before sending", async (t) => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || undefined });
  t.after(() => browser.close());
  const page = await browser.newPage({ locale: "zh-CN" });
  page.setDefaultTimeout(6000);
  const origin = "https://anser.test";
  const dist = new URL("../dist/", import.meta.url);
  const requests = [];
  let removed = false;
  const message = { id: "original", created_at: 1780000000000, status: "success",
    message: { title: "每周通知", body: "正文", format: "text" } };
  const deliveries = [
    { id: "first", channel: "email", account_id: "one", account_name: "工作邮箱", status: "success", attempts: [] },
    { id: "second", channel: "feishu", account_id: "two", account_name: "团队", status: "dead", attempts: [] },
  ];
  await page.addInitScript(() => sessionStorage.setItem("anser.auth.session", "admin"));
  await page.route(origin + "/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith("/admin")) return route.fulfill({ path: fileURLToPath(new URL("index.html", dist)) });
    if (path.startsWith("/assets/anser/")) return route.fulfill({ path: fileURLToPath(new URL(path.slice(14), dist)) });
    if (path === "/v1/auth/me") return route.fulfill({ json: { id: "1", username: "tester", enabled: true, admin: true } });
    if (path === "/v1/messages/original/replay") {
      assert.equal(route.request().method(), "POST");
      requests.push(route.request().postDataJSON());
      return route.fulfill({ status: 202, json: { message_id: "new" } });
    }
    if (path === "/v1/messages/original/history") {
      assert.equal(route.request().method(), "DELETE");
      removed = true;
      return route.fulfill({ status: 204 });
    }
    if (path === "/v1/messages") return route.fulfill({ json: { items: removed ? [] : [message] } });
    if (path.startsWith("/v1/messages/")) return route.fulfill({ json: { ...message, deliveries } });
    return route.fulfill({ json: { items: [] } });
  });
  const replay = page.getByRole("button", { name: "重放通知", exact: true });
  const modal = page.getByRole("alertdialog");
  const confirm = modal.getByRole("button", { name: "确认重放" });
  await page.goto(origin + "/admin/messages");
  await replay.click();
  const failed = modal.getByRole("checkbox", { name: /团队/ });
  const sent = modal.getByRole("checkbox", { name: /工作邮箱/ });
  assert.equal(await failed.isChecked(), true);
  assert.equal(await sent.isChecked(), false);
  await failed.uncheck();
  assert.equal(await confirm.isDisabled(), true);
  await modal.getByRole("button", { name: "取消" }).click();
  assert.equal(requests.length, 0);
  await replay.click();
  await confirm.click();
  await page.waitForURL("**/admin/messages/new");
  assert.deepEqual(requests.pop(), { delivery_ids: ["second"] });

  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(origin + "/admin/messages/original");
  await replay.click();
  await sent.check();
  await confirm.click();
  await page.waitForURL("**/admin/messages/new");
  assert.deepEqual(requests.pop().delivery_ids.sort(), ["first", "second"]);

  for (const status of ["success", "failed"]) {
    message.status = status;
    deliveries.forEach((delivery) => delivery.status = status);
    await page.goto(origin + "/admin/messages/original");
    await replay.click();
    await modal.getByText("重放发往邮件和飞书的通知？").waitFor();
    assert.equal(await modal.getByRole("checkbox").count(), 0);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await confirm.click();
    await page.waitForURL("**/admin/messages/new");
    assert.deepEqual(requests.pop(), { delivery_ids: ["first", "second"] });
  }

  message.status = "success";
  deliveries[0].status = "sending";
  await page.goto(origin + "/admin/messages/original");
  await page.getByRole("heading", { name: "投递结果" }).waitFor();
  assert.equal(await replay.count(), 0);

  deliveries[0].status = "success";
  await page.goto(origin + "/admin/messages");
  await page.getByRole("button", { name: "删除", exact: true }).click();
  await modal.getByRole("button", { name: "取消" }).click();
  assert.equal(removed, false);
  await page.getByRole("button", { name: "删除", exact: true }).click();
  await modal.getByRole("button", { name: "删除记录" }).click();
  await page.getByText("暂无投递记录", { exact: true }).waitFor();
  assert.equal(removed, true);
});
