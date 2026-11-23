import assert from "node:assert/strict";
import test from "node:test";
import { channelConfigOptionName, channelDisplayName, chooseLanguage, chooseTheme, resolveTheme, translate } from "../src/locale.ts";

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

test("each interface language uses one brand and channel display name", () => {
  assert.equal(translate("zh-CN", "雁字"), "雁字");
  assert.equal(translate("en", "雁字"), "Anser");
  assert.equal(translate("zh-CN", "英文"), "英文");
  assert.equal(translate("en", "简体中文"), "Simplified Chinese");
  assert.equal(translate("zh-CN", "API 密钥"), "API 密钥");
  assert.equal(translate("en", "API 密钥"), "API Keys");
  assert.equal(channelDisplayName("zh-CN", "feishu", "飞书 / Lark"), "飞书");
  assert.equal(channelDisplayName("en", "feishu", "飞书 / Lark"), "Feishu");
  assert.equal(channelDisplayName("zh-CN", "email", "SMTP 邮件"), "邮件");
  assert.equal(channelDisplayName("en", "email", "SMTP 邮件"), "Email");
  assert.equal(channelDisplayName("en", "serverchan", "Server酱"), "ServerChan");
  assert.equal(channelDisplayName("en", "qqbot", "QQ 机器人"), "QQ Bot");
  assert.equal(channelDisplayName("zh-CN", "dingtalk", "DingTalk"), "钉钉");
  for (const brand of ["Chanify", "Discord", "Gotify", "IFTTT", "Slack"]) {
    for (const language of ["en", "zh-CN"] as const) {
      assert.equal(channelDisplayName(language, brand.toLowerCase()), brand);
    }
  }
  assert.equal(channelConfigOptionName("zh-CN", "guild_channel"), "子频道");
  assert.equal(channelConfigOptionName("en", "group"), "Group chat");
  assert.equal(channelDisplayName("en", "custom", "Provider name"), "Provider name");
  assert.equal(channelDisplayName("zh-CN", "__proto__"), "__proto__");
});
