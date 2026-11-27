import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium } from "playwright-core";

test("name a pairing code and manage the paired session from desktop and mobile", async (t) => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || undefined });
  t.after(() => browser.close());
  const page = await browser.newPage({ locale: "en-US" });
  page.setDefaultTimeout(8000);
  await page.clock.install();
  const origin = "https://anser.test";
  const assets = "/assets/anser/";
  const dist = new URL("../dist/", import.meta.url);
  const session = {
    id: "pair-1", username: "taylor", user_id: "user-1", name: "Office Mac", created_at: Date.now(),
    enabled: true, expires_at: Date.now() + 3600000, last_used_at: null,
  };
  let revocations = 0;
  let paired = false;
  let listRequests = 0;
  await page.addInitScript(() => sessionStorage.setItem("anser.auth.session", "test-session"));
  await page.route(origin + "/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/admin")) return route.fulfill({ path: fileURLToPath(new URL("index.html", dist)) });
    if (path.startsWith(assets)) return route.fulfill({ path: fileURLToPath(new URL(path.slice(assets.length), dist)) });
    if (path === "/v1/auth/me") return route.fulfill({ json: { id: "admin", username: "admin", admin: true, enabled: true } });
    if (path === "/v1/auth/pair") {
      assert.deepEqual(request.postDataJSON(), { server: origin, name: "Tablet" });
      const link = new URL("anser://connect");
      link.searchParams.set("server", origin);
      link.searchParams.set("code", "p".repeat(43));
      return route.fulfill({ json: { url: link.toString(), expires_at: Date.now() + 60_000 } });
    }
    if (path === "/v1/auth/paired-clients") {
      listRequests++;
      return route.fulfill({ json: { items: paired ? [session] : [] } });
    }
    if (path === "/v1/auth/paired-clients/pair-1") {
      if (request.method() === "PATCH") {
        assert.deepEqual(request.postDataJSON(), { name: "Home Mac" });
        session.name = request.postDataJSON().name;
      } else {
        assert.equal(request.method(), "DELETE");
        session.enabled = false;
        revocations++;
      }
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ json: { items: [] } });
  });
  await page.goto(origin + "/admin/pair");
  await page.getByText("No paired clients yet").waitFor();
  await page.getByLabel("Device name (optional)").fill("Tablet");
  await page.getByRole("button", { name: "Generate pairing code" }).click();
  await page.locator("canvas").waitFor();
  paired = true; // A remote device exchanges the code while this page stays open.
  await page.clock.fastForward(5100);
  const table = page.getByRole("table", { name: "Paired clients" });
  await table.getByText("taylor").waitFor();
  await table.getByRole("button", { name: "Rename device" }).click();
  const editor = page.getByRole("dialog");
  await editor.waitFor();
  const requestsBeforeEdit = listRequests;
  await page.clock.fastForward(5100);
  assert.equal(listRequests, requestsBeforeEdit, "leave the list in place while editing a client");
  await editor.getByLabel("Device name").fill(" Home Mac ");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await table.getByText("Home Mac").waitFor();
  await page.setViewportSize({ width: 375, height: 800 });
  const revoke = table.getByRole("button", { name: "Revoke pairing" });
  await revoke.click();
  const confirm = page.getByRole("alertdialog");
  await confirm.getByText("Revoke pairing for “Home Mac”?").waitFor();
  await confirm.getByRole("button", { name: "Cancel" }).click();
  assert.equal(revocations, 0);
  await revoke.click();
  await confirm.getByRole("button", { name: "Revoke pairing", exact: true }).click();
  await table.getByText("Revoked", { exact: true }).waitFor();
  assert.equal(revocations, 1);
  assert.equal(await revoke.count(), 0);
  await page.clock.fastForward(65_000);
  await page.locator("canvas").waitFor({ state: "detached" });
  await page.waitForLoadState("networkidle");
  const requestsAtExpiry = listRequests;
  await page.clock.fastForward(11_000);
  assert.equal(listRequests, requestsAtExpiry, "stop polling after code expiry");
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
});
