import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium } from "playwright-core";

test("saved TTS settings load provider voices and can be edited without re-entering the key", async (t) => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || undefined });
  t.after(() => browser.close());
  const page = await browser.newPage({ locale: "en", viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(6000);
  const site = "https://anser.test";
  const dist = new URL("../dist/", import.meta.url);
  const base = "/v1/plugins/content_transform/openai-tts";
  let saved = {
    config: { server_url: "https://provider.example", model: "tts-1", voice: "alloy", response_format: "mp3", audio_retention_days: 7 },
    saved_credentials: ["api_key"],
    revision: "first",
  };
  let submitted;
  let ran;
  const plugin = {
    id: "openai-tts", kind: "content_transform", display_name: "OpenAI TTS", available: true, enabled: true,
    config_schema: {
      "x-anser-ui": { persistent_settings: true, account_editor: { credentials: { api_key: ["server_url"] } } },
      properties: {
        api_key: { type: "string", writeOnly: true, "x-anser-ui": { label: { en: "API key" } } },
        server_url: { type: "string" }, model: { type: "string" }, response_format: { type: "string" },
        audio_retention_days: { type: "integer", minimum: 1, maximum: 365, "x-anser-ui": { label: { en: "Audio retention (days)" } } },
        voice: { type: "string", "x-anser-ui": {
          label: { en: "Voice" }, dynamic_options: { fields: ["server_url", "api_key", "model"] },
        } },
      },
      required: ["api_key", "server_url", "model", "voice"],
    },
  };
  await page.route(site + "/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith("/admin")) return route.fulfill({ path: fileURLToPath(new URL("index.html", dist)) });
    const asset = "/assets/anser/";
    if (path.startsWith(asset)) return route.fulfill({ path: fileURLToPath(new URL(path.slice(asset.length), dist)) });
    if (path === "/v1/auth/me") return route.fulfill({ json: { id: "1", username: "editor", admin: true, enabled: true } });
    if (path === "/v1/plugins") return route.fulfill({ json: { items: [plugin] } });
    if (path === base + "/config") {
      if (route.request().method() === "PUT") {
        submitted = route.request().postDataJSON();
        saved = { ...saved, config: submitted.config, revision: "second" };
      }
      return route.fulfill({ json: saved });
    }
    if (path === base + "/options/voice") {
      assert.deepEqual(route.request().postDataJSON(), {
        config: { server_url: "https://provider.example", model: "tts-1" }, config_revision: saved.revision,
      });
      return route.fulfill({ json: { items: [{ label: "Alloy", value: "alloy" }, { label: "Cedar", value: "cedar" }] } });
    }
    if (path === base + "/run") {
      ran = route.request().postDataJSON();
      return route.fulfill({ json: { message: { body: "Test" } } });
    }
    return route.fulfill({ json: { items: [] } });
  });
  await page.addInitScript(() => sessionStorage.setItem("anser.auth.session", "test-session"));
  await page.goto(site + "/admin/channels");
  const open = () => page.getByRole("button", { name: "Configure OpenAI TTS" }).click();
  const dialog = page.getByRole("dialog");
  await open();
  assert.equal(await dialog.getByLabel("API key", { exact: true }).inputValue(), "");
  const voice = dialog.getByRole("combobox", { name: "Voice", exact: true });
  await voice.click();
  await dialog.getByRole("option", { name: "Cedar", exact: true }).click();
  await dialog.getByLabel("Audio retention (days)", { exact: true }).fill("14");
  await dialog.getByRole("button", { name: "Save plugin settings" }).click();
  await dialog.getByText("Plugin settings saved.", { exact: true }).waitFor();
  assert.equal(submitted.config.voice, "cedar");
  assert.equal(submitted.config.audio_retention_days, 14);
  assert.equal(submitted.config_revision, "first");
  assert.ok(!Object.hasOwn(submitted.config, "api_key"));
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  const optionsReady = page.waitForResponse((response) => response.url().endsWith("/options/voice") && response.ok());
  await open();
  await optionsReady;
  const selected = await voice.inputValue();
  assert.equal(selected.toLowerCase(), "cedar");
  await dialog.getByLabel("Content to transform").fill("Test");
  await dialog.getByRole("button", { name: "Run plugin", exact: true }).click();
  await dialog.getByRole("region", { name: "Run result" }).getByText("Test", { exact: true }).waitFor();
  assert.equal(ran.config.voice, "cedar");
  assert.equal(ran.config_revision, "second");
  assert.ok(!Object.hasOwn(ran.config, "api_key"));
});
