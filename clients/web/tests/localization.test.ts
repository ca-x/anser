import assert from "node:assert/strict";
import test from "node:test";
import { chooseLanguage, chooseTheme, resolveTheme, translate } from "../src/locale.ts";

test("saved language outranks the browser default", () => {
  assert.equal(chooseLanguage("zh-CN", "en-US"), "zh-CN");
  assert.equal(chooseLanguage("en", "zh-Hans-CN"), "en");
  assert.equal(chooseLanguage(null, "zh-Hans-CN"), "zh-CN");
  assert.equal(chooseLanguage("invalid", "de-DE"), "en");
});

test("system theme follows OS changes while manual themes override the OS", () => {
  const system = chooseTheme("system");
  assert.equal(chooseTheme(null), "system");
  assert.equal(chooseTheme("invalid"), "system");
  assert.equal(resolveTheme(system, false), "light");
  assert.equal(resolveTheme(system, true), "dark");
  assert.equal(resolveTheme(chooseTheme("light"), true), "light");
  assert.equal(resolveTheme(chooseTheme("dark"), false), "dark");
});

test("templates localize their copy without interpreting user-entered labels", () => {
  const account = "project {name}";
  assert.equal(translate("en", "删除账号「{name}」？", { name: account }), "Delete account project {name}?");
  assert.equal(translate("zh-CN", "删除账号「{name}」？", { name: account }), "删除账号「project {name}」？");
  assert.equal(translate("zh-CN", "Channel unavailable"), "此渠道当前不可用。");
  assert.equal(translate("en", "untranslated provider diagnostic"), "untranslated provider diagnostic");
  assert.equal(translate("en", "__proto__"), "__proto__");
});
