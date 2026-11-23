import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium } from "playwright-core";

test("About loads the running version and its logo disclosure works with keyboard and reduced motion", async (t) => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || undefined });
  t.after(() => browser.close());
  const page = await browser.newPage({ locale: "en", viewport: { width: 1240, height: 820 } });
  const site = "https://anser.test";
  const dist = new URL("../dist/", import.meta.url);
  let infoAttempts = 0;
  await page.route(site + "/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith("/admin")) return route.fulfill({ path: fileURLToPath(new URL("index.html", dist)) });
    const prefix = "/assets/anser/";
    if (path.startsWith(prefix)) return route.fulfill({ path: fileURLToPath(new URL(path.slice(prefix.length), dist)) });
    if (path === "/v1/auth/me") return route.fulfill({ json: { id: "1", username: "editor", admin: true, enabled: true } });
    if (path === "/v1/info") {
      if (!infoAttempts++) return route.fulfill({ status: 503, json: { message: "Service unavailable" } });
      return route.fulfill({ json: { version: "12.34.56" } });
    }
    return route.fulfill({ json: { items: [] } });
  });
  await page.addInitScript(() => sessionStorage.setItem("anser.auth.session", "test-session"));
  await page.goto(site + "/admin/about");
  await page.getByRole("heading", { name: "About Anser" }).waitFor();
  await page.getByRole("button", { name: "Reload" }).click();
  await page.getByText("12.34.56", { exact: true }).waitFor();
  assert.equal(await page.getByRole("link", { name: "Release notes" }).getAttribute("href"),
    "https://github.com/ca-x/anser/releases/tag/v12.34.56");
  const logo = page.getByRole("button", { name: "Behind the logo" });
  await logo.locator("svg path").waitFor();
  await logo.focus();
  await page.keyboard.press("Enter");
  assert.equal(await logo.getAttribute("aria-expanded"), "true");
  assert.equal(await page.locator("#about-story").isVisible(), true);
  await page.keyboard.press("Space");
  assert.equal(await page.locator("#about-story").isVisible(), false);
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
  await page.setViewportSize({ width: 320, height: 690 });
  await logo.click();
  await page.waitForFunction(() => {
    const image = document.querySelector(".about-mark[aria-expanded=true] > img");
    if (!image || !matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
    const style = getComputedStyle(image);
    return style.transform === "none" && style.transitionProperty === "none";
  });
  assert.equal(await page.locator("#about-story").isVisible(), true);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  assert.equal(await page.getByRole("link", { name: "About", exact: true }).getAttribute("aria-current"), "page");
});
