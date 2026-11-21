export type JsonObject = Record<string, unknown>;
export type Format = "text" | "markdown" | "html";
export type Mode = "broadcast" | "failover" | "weighted" | "weighted_failover";
export type Criteria = "any" | "all";

export interface Page<T> { items: T[]; next_cursor?: string | null }
export interface User { id: string; username: string; enabled: boolean; admin: boolean; created_at?: number }
export interface SignIn { token: string; user: User }
export interface TotpStatus { enabled: boolean }
export interface TotpSetup { secret: string; uri: string; expires_at: number }
export interface TotpConfirmation { enabled: true; recovery_codes: string[] }
export interface PairCode { url: string; expires_at: number }
export interface ApiKey {
  id: string;
  name: string;
  scopes: string[];
  topic_prefix?: string | null;
  expires_at?: number | null;
  last_used_at?: number | null;
  enabled: boolean;
}
export interface IssuedKey { token: string; key: ApiKey }
export interface Channel {
  id: string;
  display_name: string;
  enabled?: boolean;
  available?: boolean;
  can_manage?: boolean;
  config_schema: JsonObject;
  capabilities: { formats: Format[]; attachments: boolean; user_target: boolean };
}
export interface ChannelRuntime {
  id: string;
  enabled?: boolean;
  available: boolean;
}
export interface Account {
  id: string;
  channel: string;
  name: string;
  tags: string[];
  weight: number;
  priority: number;
  enabled: boolean;
  rate_limit?: number | null;
}
export interface Target {
  channel?: string;
  account_id?: string;
  tag_selector?: string[];
  weight?: number;
  priority?: number;
}
export interface Retry {
  max_attempts: number;
  backoff: "fixed" | "exponential";
  base_delay: number;
  max_delay: number;
  jitter: boolean;
  until_success: boolean;
  ttl: number;
}
export interface Policy {
  mode: Mode;
  targets: Target[];
  retry: Retry;
  success_criteria: Criteria;
}
export interface Topic {
  name: string;
  description: string;
  enabled: boolean;
  default_tags: string[];
  retention?: number | null;
  protected?: boolean;
  policy: Policy;
}
export interface Subscription {
  id: string;
  subscriber_ref: string;
  account_id?: string | null;
  filter: string[];
  created_at: number;
}
export interface Message {
  title: string;
  body: string;
  format: Format;
  tags?: string[];
  url?: string | null;
  level?: string | null;
  attachments?: { url: string; name?: string; content_type?: string }[];
  extras?: JsonObject;
}
export interface Publish extends Message {
  channels?: (string | Target)[];
  strategy?: Partial<Omit<Policy, "targets">>;
  expire_at?: number;
  callback_url?: string;
  topic_password?: string;
}
export interface Receipt { message_id: string; status: string }
export interface Attempt {
  n: number;
  started_at: number;
  finished_at?: number | null;
  error_code?: string | null;
  error_msg?: string | null;
  latency?: number | null;
}
export interface Delivery {
  id: string;
  channel: string;
  account_id: string;
  subscription_id?: string | null;
  status: string;
  next_retry_at?: number | null;
  attempts: Attempt[];
}
export interface MessageDetail { id: string; topic?: string | null; status: string; message: Message; created_at: number; deliveries?: Delivery[] }

export const segment = encodeURIComponent;

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class Api {
  #token: string | undefined;
  readonly unauthorized?: () => void;

  constructor(token?: string, unauthorized?: () => void) {
    this.#token = token;
    this.unauthorized = unauthorized;
  }

  read<T>(path: string, signal?: AbortSignal) { return this.request<T>(path, { signal }); }
  write<T>(path: string, method: "POST" | "PUT" | "DELETE", value?: unknown) {
    return this.request<T>(path, {
      method,
      body: value === undefined ? undefined : JSON.stringify(value),
    });
  }
  send(topic: string | undefined, message: Publish, key: string) {
    const path = topic ? `/topics/${segment(topic)}/publish` : "/send";
    return this.request<Receipt>(path, {
      method: "POST",
      headers: { "Idempotency-Key": key },
      body: JSON.stringify(message),
    });
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (init.body !== undefined) headers.set("Content-Type", "application/json");
    if (this.#token) headers.set("Authorization", `Bearer ${this.#token}`);
    const timer = AbortSignal.timeout(30000);
    const signal = init.signal ? AbortSignal.any([init.signal, timer]) : timer;
    let response: Response;
    try {
      response = await fetch(`/v1${path}`, { ...init, headers, signal, redirect: "error", cache: "no-store" });
    } catch (error) {
      if (init.signal?.aborted) throw error;
      throw new ApiError(0, timer.aborted ? "请求超时，请稍后重试。" : "无法连接雁字服务，请检查网络。");
    }
    if (response.status === 204) return undefined as T;
    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const error = payload && typeof payload === "object" ? payload as Record<string, unknown> : undefined;
      const code = typeof error?.code === "string" ? error.code : undefined;
      if (response.status === 401 && code !== "invalid_totp" && code !== "totp_required") this.unauthorized?.();
      const reason = typeof error?.message === "string" ? error.message : `HTTP ${response.status}`;
      throw new ApiError(response.status, reason, code);
    }
    if (payload === undefined) throw new ApiError(response.status, "服务器未返回雁字 JSON 数据。");
    return payload as T;
  }
}

export function errorMessage(error: unknown) {
  if (error instanceof ApiError && error.code === "invalid_totp") return "验证码无效或已使用，请输入新代码。";
  if (error instanceof ApiError && error.code === "invalid_password") return "当前密码不正确。";
  if (error instanceof ApiError && error.code === "totp_setup_expired") return "设置已过期，请输入当前密码重新开始。";
  if (error instanceof ApiError && error.code === "totp_already_enabled") return "双重验证已启用。";
  if (error instanceof ApiError && error.code === "totp_not_enabled") return "双重验证已停用。";
  return error instanceof Error ? error.message : "请求未完成。";
}
