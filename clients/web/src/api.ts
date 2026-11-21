export type JsonObject = Record<string, unknown>;
export type Format = "text" | "markdown" | "html";
export type Mode = "broadcast" | "failover" | "weighted" | "weighted_failover";
export type Criteria = "any" | "all";

export interface Page<T> { items: T[]; next_cursor?: string | null }
export interface User { id: string; username: string; enabled: boolean; admin: boolean; created_at?: number }
export interface SignIn { token: string; user: User }
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
  available?: boolean;
  config_schema: JsonObject;
  capabilities: { formats: Format[]; attachments: boolean; user_target: boolean };
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
  constructor(readonly status: number, message: string) { super(message); }
}

export class Api {
  #token: string | undefined;

  constructor(token?: string, readonly unauthorized?: () => void) {
    this.#token = token;
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
      throw new ApiError(0, timer.aborted ? "请求超时，请稍后重试。" : "无法连接 Anser 服务，请检查网络。");
    }
    if (response.status === 401) this.unauthorized?.();
    if (response.status === 204) return undefined as T;
    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const reason = payload && typeof payload === "object" && "message" in payload && typeof payload.message === "string"
        ? payload.message : `HTTP ${response.status}`;
      throw new ApiError(response.status, reason);
    }
    if (payload === undefined) throw new ApiError(response.status, "服务器未返回 Anser JSON 数据。");
    return payload as T;
  }
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "请求未完成。";
}
