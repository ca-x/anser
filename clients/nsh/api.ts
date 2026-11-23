import { t } from "nsh/i18n";
import type {
  Acceptance,
  Account,
  Channel,
  ChannelRuntime,
  HistoryEntry,
  InboxItem,
  JsonObject,
  LazycatDevices,
  Message,
  Page,
  PersonalProfile,
  Policy,
  ProxyProfile,
  ProxyProfileInput,
  Publish,
  SignIn,
  Subscription,
  Topic,
  TotpSetup,
  TotpStatus,
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
      t("api.enter_a_complete_server_address_such"),
    );
  }
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new ApiError("invalid_url", t("api.use_only_the_protocol_host_and"));
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new ApiError(
      "invalid_url",
      t("api.remote_servers_require_https_http_is"),
    );
  }
  return url.origin;
}

export function messageFor(error: unknown): string {
  return error instanceof ApiError
    ? error.message
    : t("api.the_request_could_not_be_completed");
}

function segment(value: string) {
  return encodeURIComponent(value);
}

function pagePath(path: string, cursor?: string | null) {
  if (!cursor) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}cursor=${encodeURIComponent(cursor)}`;
}

const authErrors = new Map([
  ["totp_required", "security.second_factor_required"],
  ["invalid_totp", "security.invalid_code"],
  ["invalid_password", "security.invalid_password"],
  ["totp_setup_expired", "security.setup_expired"],
  ["totp_already_enabled", "security.already_enabled"],
  ["totp_not_enabled", "security.not_enabled"],
  ["invalid_nickname", "profile.nickname_limit"],
  ["invalid_avatar", "profile.avatar_rejected"],
]);

export class AnserApi {
  readonly origin: string;
  readonly #key: string | undefined;
  readonly #session = new AbortController();

  constructor(origin: string, key: string | undefined) {
    this.origin = validateOrigin(origin);
    this.#key = key?.trim();
    if (key !== undefined && (!this.#key || /\s/.test(this.#key))) {
      throw new ApiError("invalid_key", t("api.enter_the_full_api_key"));
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
      const data =
        response.status === 204
          ? undefined
          : await response.json().catch(() => undefined);
      const payload = data as { code?: string; message?: string } | undefined;
      if (
        !response.ok &&
        payload?.code &&
        (path === "/auth/login" ||
          path === "/auth/profile" ||
          path.startsWith("/auth/totp"))
      ) {
        const message = authErrors.get(payload.code);
        if (message)
          throw new ApiError(payload.code, t(message), response.status);
      }
      if (response.status === 401)
        throw new ApiError(
          "unauthorized",
          this.#key
            ? t("api.your_session_has_expired_or_the")
            : t("api.invalid_credentials_or_pairing_code"),
          401,
        );
      if (
        response.status === 403 &&
        path === "/channels/lazycat/devices" &&
        payload?.code === "lazycat_identity_required"
      ) {
        throw new ApiError(payload.code, t("devices.identity_required"), 403);
      }
      if (response.status === 403)
        throw new ApiError(
          "forbidden",
          t("api.your_credentials_do_not_allow_this"),
          403,
        );
      if (!response.ok) {
        throw new ApiError(
          payload?.code ?? "http_error",
          payload?.message ?? t("api.http_status", { status: response.status }),
          response.status,
        );
      }
      if (data === undefined && response.status !== 204) {
        throw new ApiError(
          "invalid_response",
          t("api.the_server_did_not_return_an"),
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
        throw new ApiError(
          "network_denied",
          t("api.the_app_does_not_have_network"),
        );
      }
      if (abort.signal.aborted)
        throw new ApiError(
          "timeout",
          t("api.the_connection_or_request_timed_out"),
        );
      throw new ApiError(
        "network_error",
        t("api.could_not_reach_the_server_check"),
      );
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      session.removeEventListener("abort", onAbort);
    }
  }

  login(username: string, password: string, code?: string) {
    return this.request<SignIn>("/auth/login", "POST", {
      username,
      password,
      code,
    });
  }

  exchange(code: string) {
    return this.request<SignIn>("/auth/pair/exchange", "POST", { code });
  }

  me(signal?: AbortSignal) {
    return this.request<User>("/auth/me", "GET", undefined, signal);
  }

  profile(signal?: AbortSignal) {
    return this.request<PersonalProfile>(
      "/auth/profile",
      "GET",
      undefined,
      signal,
    );
  }

  saveProfile(profile: PersonalProfile) {
    return this.request<PersonalProfile>("/auth/profile", "PUT", profile);
  }

  info(signal?: AbortSignal) {
    return this.request<{ version: string }>("/info", "GET", undefined, signal);
  }

  logout() {
    return this.request<void>("/auth/logout", "POST");
  }

  totpStatus(signal?: AbortSignal) {
    return this.request<TotpStatus>("/auth/totp", "GET", undefined, signal);
  }

  setupTotp(password: string, signal: AbortSignal) {
    return this.request<TotpSetup>(
      "/auth/totp/setup",
      "POST",
      { password },
      signal,
    );
  }

  confirmTotp(code: string, signal: AbortSignal) {
    return this.request<TotpStatus & { recovery_codes: string[] }>(
      "/auth/totp/confirm",
      "POST",
      { code },
      signal,
    );
  }

  disableTotp(password: string, code: string, signal: AbortSignal) {
    return this.request<TotpStatus>(
      "/auth/totp/disable",
      "POST",
      { password, code },
      signal,
    );
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
  sendInbox(recipient: string, message: Message, idempotencyKey: string) {
    return this.request<{ id: number; message_id?: string }>(
      "/inbox/send",
      "POST",
      {
        ...message,
        recipient,
      },
      undefined,
      idempotencyKey,
    );
  }

  async channels(signal?: AbortSignal): Promise<Channel[]> {
    const result = await this.request<Page<Channel>>(
      "/channels",
      "GET",
      undefined,
      signal,
    );
    if (!Array.isArray(result?.items))
      throw new ApiError(
        "invalid_response",
        t("api.this_server_did_not_return_an"),
      );
    return result.items;
  }

  channel(id: string, signal?: AbortSignal) {
    return this.request<Channel>(
      `/channels/${segment(id)}`,
      "GET",
      undefined,
      signal,
    );
  }

  lazycatDevices(signal?: AbortSignal, accountId?: string) {
    return this.request<LazycatDevices>(
      accountId ? `/channels/lazycat/devices?account_id=${encodeURIComponent(accountId)}` : "/channels/lazycat/devices",
      "GET",
      undefined,
      signal,
    );
  }

  changeChannel(id: string, change: { enabled: boolean } | { reload: true }) {
    return this.request<ChannelRuntime>(
      `/channels/${segment(id)}/runtime`,
      "PUT",
      change,
    );
  }

  accounts(cursor?: string | null, signal?: AbortSignal, channel?: string) {
    return this.request<Page<Account>>(
      pagePath(
        channel ? `/accounts?channel=${segment(channel)}` : "/accounts",
        cursor,
      ),
      "GET",
      undefined,
      signal,
    );
  }

  proxies(cursor?: string | null, signal?: AbortSignal) {
    return this.request<Page<ProxyProfile>>(
      pagePath("/proxies", cursor),
      "GET",
      undefined,
      signal,
    );
  }

  saveProxy(id: string | undefined, input: ProxyProfileInput) {
    return this.request<ProxyProfile>(
      id ? `/proxies/${segment(id)}` : "/proxies",
      id ? "PUT" : "POST",
      input,
    );
  }

  async deleteProxy(id: string) {
    try {
      await this.request<void>(`/proxies/${segment(id)}`, "DELETE");
    } catch (error) {
      if (error instanceof ApiError && error.code === "proxy_in_use")
        throw new ApiError(error.code, t("proxies.in_use"), 409);
      throw error;
    }
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
