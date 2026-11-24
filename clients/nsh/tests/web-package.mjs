import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const [playwright, url] = process.argv.slice(2);
const { chromium } = await import(pathToFileURL(playwright).href);
const browser = await chromium.launch({ channel: "chrome" });
try {
  const page = await browser.newPage({ locale: "en-US", colorScheme: "light" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  await page.getByText("Connect to an Anser server", { exact: true }).waitFor();
  await page.waitForFunction(() => document.title === "Anser");
  await page.getByText("Preferences", { exact: true }).click();
  const appearance = page.getByRole("combobox", { name: "Appearance" });
  await appearance.click();
  await page.getByText("Dark", { exact: true }).click();
  assert.equal(await appearance.getAttribute("aria-valuetext"), "Dark");
  await appearance.click();
  assert.equal(await page.getByText("Omarchy desktop theme", { exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  console.log("Packaged Web client renders, changes appearance, and hides the Omarchy theme.");
} finally {
  await browser.close();
}
