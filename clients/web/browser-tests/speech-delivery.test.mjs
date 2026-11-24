import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium } from "playwright-core";

test("plays a stored speech recording in a narrow delivery detail view", async (t) => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || undefined });
  t.after(() => browser.close());
  const page = await browser.newPage({ locale: "zh-CN", viewport: { width: 360, height: 720 } });
  const origin = "https://anser.test";
  const audioPath = "/v1/speech/audio/" + "a".repeat(43) + ".mp3";
  const dist = new URL("../dist/", import.meta.url);
  let audioRequests = 0;
  await page.route(origin + "/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === audioPath) {
      audioRequests++;
      return route.fulfill({ path: fileURLToPath(new URL("fixtures/voice.mp3", import.meta.url)), contentType: "audio/mpeg" });
    }
    if (path.startsWith("/admin")) return route.fulfill({ path: fileURLToPath(new URL("index.html", dist)) });
    const prefix = "/assets/anser/";
    if (path.startsWith(prefix)) return route.fulfill({ path: fileURLToPath(new URL(path.slice(prefix.length), dist)) });
    if (path === "/v1/auth/me") return route.fulfill({ json: { id: "1", username: "editor", admin: true, enabled: true } });
    if (path === "/v1/messages/speech") return route.fulfill({
      json: {
        id: "speech", status: "success", created_at: 1780000000000, audio_path: audioPath,
        message: { title: "", body: origin + audioPath + "\n\n语音正文", format: "text" }, inbox_deliveries: 1,
      },
    });
    return route.fulfill({ json: { items: [] } });
  });
  await page.addInitScript(() => sessionStorage.setItem("anser.auth.session", "test-session"));
  await page.goto(origin + "/admin/messages/speech");
  const player = page.locator("audio[aria-label='播放语音通知']");
  await player.waitFor();
  assert.equal(audioRequests, 0, "only load the recording on request");
  assert.equal(await player.getAttribute("controls"), "");
  await player.evaluate((audio) => audio.play());
  await page.waitForFunction(() => document.querySelector("audio")?.ended);
  assert.ok(audioRequests > 0);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
});
