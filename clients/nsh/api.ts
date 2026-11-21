import type {
  Acceptance,
  Account,
  Channel,
  HistoryEntry,
  InboxItem,
  JsonObject,
  Message,
  Page,
  Policy,
  Publish,
  SignIn,
  Subscription,
  Topic,
  User,
} from "./contracts";

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export function validateOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ApiError(
      "invalid_url",
      "请输入完整的服务器地址，例如 https://anser.example.com。",
    );
  }
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new ApiError("invalid_url", "服务器地址只需协议、主机和端口。");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new ApiError(
      "invalid_url",
      "请为远程服务器使用 HTTPS。HTTP 仅供本机连接。",
    );
  }
  return url.origin;
}

export function messageFor(error: unknown): string {
  return error instanceof ApiError ? error.message : "请求未完成，请重试。";
}

function segment(value: string) {
  return encodeURIComponent(value);
}

function pagePath(path: string, cursor?: string | null) {
  return cursor ? `${path}?cursor=${encodeURIComponent(cursor)}` : path;
}

export class AnserApi {
  readonly origin: string;
  readonly #key: string | undefined;
  readonly #session = new AbortController();

  constructor(origin: string, key: string | undefined) {
    this.origin = validateOrigin(origin);
    this.#key = key?.trim();
    if (key !== undefined && (!this.#key || /\s/.test(this.#key))) {
      throw new ApiError("invalid_key", "请输入完整的 API Key。");
    }
  }

  close() {
    this.#session.abort();
  }

  private async request<T>(
    path: string,
    method: "GET" | "POST" | "PUT" | "DELETE" = "GET",
    body?: unknown,
    signal?: AbortSignal,
    idempotencyKey?: string,
  ): Promise<T> {
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    const session = this.#session.signal;
    const timeout = setTimeout(
      onAbort,
      path.includes("wait=true") ? 45000 : 15000,
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    session.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted || session.aborted) abort.abort();
    try {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (this.#key) headers.Authorization = `Bearer ${this.#key}`;
      if (body !== undefined) headers["Content-Type"] = "application/json";
      if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
      const response = await fetch(`${this.origin}/v1${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: abort.signal,
        redirect: "error",
      });
      if (response.status === 401)
        throw new ApiError(
          "unauthorized",
          this.#key
            ? "登录凭据无效或已到期，请重新连接。"
            : "登录资料或配对码无效。",
          401,
        );
      if (response.status === 403)
        throw new ApiError(
          "forbidden",
          "当前 API Key 没有这项操作的权限。",
          403,
        );
      const data =
        response.status === 204
          ? undefined
          : await response.json().catch(() => undefined);
      if (!response.ok) {
        const payload = data as { code?: string; message?: string } | undefined;
        throw new ApiError(
          payload?.code ?? "http_error",
          payload?.message ?? `服务器返回 HTTP ${response.status}。`,
          response.status,
        );
      }
      if (data === undefined && response.status !== 204) {
        throw new ApiError(
          "invalid_response",
          "服务器未返回 Anser JSON 响应。",
        );
      }
      return data as T;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (
        typeof error === "object" &&
        error &&
        "code" in error &&
        error.code === "ERR_ACCESS_DENIED"
      ) {
        throw new ApiError("network_denied", "客户端的网络权限未允许此地址。");
      }
      if (abort.signal.aborted)
        throw new ApiError("timeout", "连接或请求已超时。");
      throw new ApiError(
        "network_error",
        "无法连接服务器。请检查地址、TLS 证书和网络。",
      );
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      session.removeEventListener("abort", onAbort);
    }
  }

  login(username: string, password: string) {
    return this.request<SignIn>("/auth/login", "POST", { username, password });
  }

  exchange(code: string) {
    return this.request<SignIn>("/auth/pair/exchange", "POST", { code });
  }

  me(signal?: AbortSignal) {
    return this.request<User>("/auth/me", "GET", undefined, signal);
  }

  logout() {
    return this.request<void>("/auth/logout", "POST");
  }

  inbox(cursor?: string | null, wait = false, signal?: AbortSignal) {
    const path = pagePath("/inbox", cursor);
    return this.request<Page<InboxItem>>(
      wait ? `${path}${cursor ? "&" : "?"}wait=true` : path,
      "GET",
      undefined,
      signal,
    );
  }
  readInbox(id: number) {
    return this.request<void>(`/inbox/${id}/read`, "POST");
  }
  sendInbox(recipient: string, message: Message) {
    return this.request<unknown>("/inbox/send", "POST", {
      ...message,
      recipient,
    });
  }

  async channels(signal?: AbortSignal): Promise<Channel[]> {
    const result = await this.request<Page<Channel>>(
      "/channels",
      "GET",
      undefined,
      signal,
    );
    if (!Array.isArray(result?.items))
      throw new ApiError("invalid_response", "此服务器未返回 Anser 渠道清单。");
    return result.items;
  }

  accounts(cursor?: string | null, signal?: AbortSignal) {
    return this.request<Page<Account>>(
      pagePath("/accounts", cursor),
      "GET",
      undefined,
      signal,
    );
  }
  saveAccount(id: string | undefined, body: JsonObject) {
    return this.request<Account>(
      id ? `/accounts/${segment(id)}` : "/accounts",
      id ? "PUT" : "POST",
      body,
    );
  }
  deleteAccount(id: string) {
    return this.request<void>(`/accounts/${segment(id)}`, "DELETE");
  }
  testAccount(id: string, message: Message) {
    return this.request<unknown>(
      `/accounts/${segment(id)}/test`,
      "POST",
      message,
    );
  }

  topics(cursor?: string | null, signal?: AbortSignal) {
    return this.request<Page<Topic>>(
      pagePath("/topics", cursor),
      "GET",
      undefined,
      signal,
    );
  }
  defaultRoute(signal?: AbortSignal) {
    return this.request<Policy>("/default-route", "GET", undefined, signal);
  }
  saveDefaultRoute(policy: Policy) {
    return this.request<Policy>("/default-route", "PUT", policy);
  }
  saveTopic(
    existing: string | undefined,
    body: Topic & { password?: string | null },
  ) {
    return this.request<Topic>(
      existing ? `/topics/${segment(existing)}` : "/topics",
      existing ? "PUT" : "POST",
      body,
    );
  }
  deleteTopic(name: string) {
    return this.request<void>(`/topics/${segment(name)}`, "DELETE");
  }
  subscriptions(name: string, cursor?: string | null, signal?: AbortSignal) {
    return this.request<Page<Subscription>>(
      pagePath(`/topics/${segment(name)}/subscriptions`, cursor),
      "GET",
      undefined,
      signal,
    );
  }
  subscribe(
    name: string,
    subscription: Omit<Subscription, "id"> & {
      target?: JsonObject;
      password?: string;
    },
  ) {
    return this.request<Subscription>(
      `/topics/${segment(name)}/subscriptions`,
      "POST",
      subscription,
    );
  }
  unsubscribe(name: string, id: string) {
    return this.request<void>(
      `/topics/${segment(name)}/subscriptions/${segment(id)}`,
      "DELETE",
    );
  }

  publish(
    topic: string | undefined,
    message: Publish,
    idempotencyKey: string,
    wait?: boolean,
  ) {
    const path = topic ? `/topics/${segment(topic)}/publish` : "/send";
    return this.request<Acceptance>(
      wait ? `${path}?wait=true` : path,
      "POST",
      message,
      undefined,
      idempotencyKey,
    );
  }
  history(cursor?: string | null, signal?: AbortSignal) {
    return this.request<Page<HistoryEntry>>(
      pagePath("/messages", cursor),
      "GET",
      undefined,
      signal,
    );
  }
  message(id: string, signal?: AbortSignal) {
    return this.request<HistoryEntry>(
      `/messages/${segment(id)}`,
      "GET",
      undefined,
      signal,
    );
  }
  replay(id: string, idempotencyKey: string) {
    return this.request<Acceptance>(
      `/messages/${segment(id)}/replay`,
      "POST",
      {},
      undefined,
      idempotencyKey,
    );
  }
}
