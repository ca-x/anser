import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium } from "playwright-core";

const site = "https://anser.test";
const dist = new URL("../dist/", import.meta.url);
const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII=", "base64");

test("edits the nickname and avatar from the account menu, including on a narrow viewport", async (t) => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || undefined });
  t.after(() => browser.close());
  const page = await browser.newPage({ locale: "en", viewport: { width: 390, height: 844 } });
  let profile = { nickname: null, avatar: null };
  await page.route(site + "/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/admin") return route.fulfill({ path: fileURLToPath(new URL("index.html", dist)) });
    const assets = "/assets/anser/";
    if (path.startsWith(assets)) return route.fulfill({ path: fileURLToPath(new URL(path.slice(assets.length), dist)) });
    if (path === "/v1/auth/me") return route.fulfill({ json: { id: "user", username: "editor", admin: true, enabled: true } });
    if (path === "/v1/auth/profile") {
      if (route.request().method() === "PUT") profile = route.request().postDataJSON();
      return route.fulfill({ json: profile });
    }
    return route.fulfill({ json: { items: [], next_cursor: null } });
  });
  await page.addInitScript(() => sessionStorage.setItem("anser.auth.session", "profile-fixture"));
  await page.goto(site + "/admin");
  const trigger = page.getByRole("button", { name: "Account menu" });
  await trigger.focus();
  await page.keyboard.press("Enter");
  await page.getByText("Personal settings", { exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Personal settings" });
  await dialog.getByLabel("Nickname").fill("River");
  await dialog.locator('input[type="file"]').setInputFiles({ name: "avatar.png", mimeType: "image/png", buffer: image });
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.deepEqual(profile, { nickname: "River", avatar: "data:image/png;base64," + image.toString("base64") });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.setViewportSize({ width: 1250, height: 800 });
  await page.reload();
  await trigger.getByText("River", { exact: true }).waitFor();
  await trigger.click();
  await page.getByText("Personal settings", { exact: true }).click();
  await dialog.getByRole("button", { name: "Remove avatar" }).click();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.deepEqual(profile, { nickname: "River", avatar: null });
});
