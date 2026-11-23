import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium } from "playwright-core";

const site = "https://anser.test";
const dist = new URL("../dist/", import.meta.url);

test("retry settings stay aligned and reachable after opening, zooming, resizing and saving", async (t) => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || undefined });
  t.after(() => browser.close());
  const page = await browser.newPage({ locale: "zh-CN", colorScheme: "dark", reducedMotion: "reduce" });
  const emptyPage = { items: [], next_cursor: null };
  let policy = {
    mode: "broadcast", targets: [], success_criteria: "all",
    retry: { max_attempts: 3, backoff: "exponential", base_delay: 1000, max_delay: 30000, jitter: true, until_success: false, ttl: 3600000 },
  };
  await page.route(site + "/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/admin/routing") return route.fulfill({ path: fileURLToPath(new URL("index.html", dist)) });
    if (path.startsWith("/assets/anser/")) return route.fulfill({ path: fileURLToPath(new URL(path.slice("/assets/anser/".length), dist)) });
    if (path === "/v1/auth/me") return route.fulfill({ json: { id: "user", username: "editor", admin: true, enabled: true } });
    if (path === "/v1/default-route") {
      if (route.request().method() === "PUT") policy = route.request().postDataJSON();
      return route.fulfill({ json: policy });
    }
    return route.fulfill({ json: emptyPage });
  });
  await page.addInitScript(() => sessionStorage.setItem("anser.auth.session", "layout-fixture"));
  await page.goto(site + "/admin/routing");
  await page.getByRole("button", { name: "重试和过期" }).click();

  for (const [width, zoom] of [[1280, 1], [1180, 1.5], [390, 1]]) {
    await page.setViewportSize({ width, height: 820 });
    await page.evaluate((scale) => { document.documentElement.style.zoom = String(scale); }, zoom);
    await page.waitForFunction(() => {
      const panel = document.querySelector(".euiAccordion__childWrapper");
      const last = panel?.querySelector(".euiSwitch:last-child");
      return last && last.getBoundingClientRect().bottom <= panel.getBoundingClientRect().bottom + 1;
    }, undefined, { timeout: 5000 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    if (width === 1280) {
      const first = await page.getByLabel("路由模式", { exact: true }).boundingBox();
      const second = await page.getByLabel("成功判定", { exact: true }).boundingBox();
      assert.ok(Math.abs(first.y - second.y) <= 1, "controls in the same row must align");
    }
  }
  await page.getByText("在有效期内重试直到成功", { exact: true }).click();
  await page.getByRole("button", { name: "保存默认路由" }).click();
  await page.getByText("默认路由已保存", { exact: true }).waitFor();
  assert.equal(policy.retry.until_success, true);
  await page.reload();
  await page.getByRole("button", { name: "重试和过期" }).click();
  assert.equal(await page.getByRole("switch", { name: "在有效期内重试直到成功" }).isChecked(), true);
});
