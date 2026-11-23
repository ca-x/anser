import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium } from "playwright-core";

test("dashboard and inbox receipt render a success icon from the production bundle", async (t) => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || undefined });
  t.after(() => browser.close());
  const page = await browser.newPage({ locale: "zh-CN", viewport: { width: 1280, height: 820 } });
  const dist = new URL("../dist/", import.meta.url);
  const site = "https://anser.test";
  const receipt = {
    id: "receipt", status: "success", created_at: Date.now(),
    inbox_deliveries: 1, message: { title: "已收到", body: "测试通知" }, deliveries: [],
  };
  await page.route(`${site}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith("/admin")) return route.fulfill({ path: fileURLToPath(new URL("index.html", dist)) });
    const assetPrefix = "/assets/anser/";
    if (path.startsWith(assetPrefix)) {
      return route.fulfill({ path: fileURLToPath(new URL(path.slice(assetPrefix.length), dist)) });
    }
    if (path === "/v1/auth/me") return route.fulfill({ json: { id: "user", username: "editor", admin: true, enabled: true } });
    if (path === "/v1/statistics") return route.fulfill({ json: { delivery_success: 1 } });
    if (path === "/v1/messages/receipt") return route.fulfill({ json: receipt });
    return route.fulfill({ json: { items: [], next_cursor: null } });
  });
  await page.addInitScript(() => sessionStorage.setItem("anser.auth.session", "fixture"));
  await page.goto(`${site}/admin`);
  await page.locator(".metric-success dt svg path").first().waitFor({ timeout: 5000 });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${site}/admin/messages/receipt`);
  await page.getByText("已存入 1 个个人收件箱", { exact: true }).waitFor();
  await page.locator(".euiCallOut svg path").first().waitFor({ timeout: 5000 });
});
