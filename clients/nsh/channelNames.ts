import { t } from "nsh/i18n";

const builtIn = new Set([
  "bark",
  "chanify",
  "dingtalk",
  "discord",
  "email",
  "feishu",
  "gotify",
  "ifttt",
  "lazycat",
  "ntfy",
  "qqbot",
  "serverchan",
  "slack",
  "telegram",
  "wechat-mp",
  "wecom",
]);

export function builtInChannel(id: string): boolean {
  return builtIn.has(id);
}

export function channelName(id: string, displayName?: string): string {
  return builtInChannel(id) ? t(`channel.${id}`) : (displayName ?? id);
}
