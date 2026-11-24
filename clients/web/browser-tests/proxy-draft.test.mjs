import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium } from "playwright-core";

test("the mobile proxy editor tests the draft before saving it", async (t) => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || undefined });
  t.after(() => browser.close());
  const page = await browser.newPage({ locale: "zh-CN", viewport: { width: 390, height: 690 } });
  const site = "https://anser.test";
  const dist = new URL("../dist/", import.meta.url);
  let tested;
  let writes = 0;
  await page.route(site + "/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith("/admin")) return route.fulfill({ path: fileURLToPath(new URL("index.html", dist)) });
    const prefix = "/assets/anser/";
    if (path.startsWith(prefix)) return route.fulfill({ path: fileURLToPath(new URL(path.slice(prefix.length), dist)) });
    if (path === "/v1/auth/me") return route.fulfill({ json: { id: "1", username: "editor", admin: true, enabled: true } });
    if (path === "/v1/proxies/test") {
      tested = route.request().postDataJSON();
      return route.fulfill({ json: { status: 200, latency_ms: 7 } });
    }
    if (path === "/v1/proxies" && route.request().method() === "POST") writes++;
    return route.fulfill({ json: { items: [] } });
  });
  await page.addInitScript(() => sessionStorage.setItem("anser.auth.session", "test-session"));
  await page.goto(site + "/admin/proxies");
  await page.getByRole("button", { name: "新增代理配置" }).click();
  const dialog = page.getByRole("dialog");
  const url = dialog.getByLabel("代理地址", { exact: true });
  await url.fill("https://proxy.example.test:8443");
  await dialog.getByRole("button", { name: "测试连接" }).click();
  await dialog.getByText("代理连接成功").waitFor();
  assert.deepEqual(tested, { proxy_url: "https://proxy.example.test:8443" });
  assert.equal(writes, 0);
  for (const label of ["测试连接", "保存代理配置"]) {
    const bounds = await dialog.getByRole("button", { name: label }).boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 391);
    assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 691);
  }
  await url.fill("https://changed.example.test:8443");
  assert.equal(await dialog.getByText("代理连接成功").count(), 0);
});
