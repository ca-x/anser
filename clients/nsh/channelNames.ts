import { t } from "nsh/i18n";

const builtIn = new Set([
  "bark",
  "email",
  "feishu",
  "lazycat",
  "ntfy",
  "serverchan",
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
