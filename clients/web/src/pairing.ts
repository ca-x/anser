import type { PairCode } from "./api";

export type PairingState =
  | { status: "idle" | "loading" | "expired" }
  | { status: "error"; message: string }
  | { status: "ready"; link: string; origin: string; expires: number };

// The server may replace the address entered in the form with its public origin.
export function readPairing(reply: PairCode, now: number): PairingState {
  try {
    const link = new URL(reply.url);
    const addresses = link.searchParams.getAll("server");
    const codes = link.searchParams.getAll("code");
    if (reply.url.length > 4096 || link.protocol !== "anser:" || link.host !== "connect" || link.username || link.password ||
      link.hash || (link.pathname !== "" && link.pathname !== "/") || addresses.length !== 1 ||
      codes.length !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(codes[0]) || !Number.isSafeInteger(reply.expires_at)) {
      throw new Error();
    }
    const server = new URL(addresses[0]);
    if (server.protocol !== "https:") {
      return { status: "error", message: "客户端配对需要 HTTPS。请填写手机可访问的 HTTPS 地址，并检查服务器的公开地址设置。" };
    }
    if (server.username || server.password || server.pathname !== "/" || server.search || server.hash) throw new Error();
    if (reply.expires_at <= now) return { status: "expired" };
    return { status: "ready", link: reply.url, expires: reply.expires_at, origin: server.origin };
  } catch {
    return { status: "error", message: "服务器返回的配对链接无效，请重新生成。" };
  }
}
