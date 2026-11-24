export type JsonObject = Record<string, unknown>;
export type Format = "text" | "markdown" | "html";
export type Mode = "broadcast" | "failover" | "weighted" | "weighted_failover";
export type Criteria = "any" | "all";

export interface Page<T> {
  items: T[];
  next_cursor?: string | null;
}

export interface Channel {
  id: string;
  display_name: string;
  enabled?: boolean;
  available?: boolean;
  can_manage?: boolean;
  config_schema: JsonObject;
  capabilities: {
    formats?: Format[];
    attachments?: boolean;
    user_target?: boolean;
  };
}

export type PluginKind = "channel" | "task" | "content_transform";

export interface InstalledPlugin {
  id: string;
  kind: PluginKind;
  display_name: string;
  version?: string;
  config_schema: JsonObject;
  enabled: boolean;
  available: boolean;
}

export type ChannelRuntime = Pick<Channel, "id" | "enabled" | "available">;

export interface Account {
  id: string;
  channel: string;
  name: string;
  tags?: string[];
  weight?: number;
  priority?: number;
  enabled: boolean;
  rate_limit?: number | null;
  proxy_id?: string | null;
}

export interface LazycatTarget {
  user_id: string;
  device_ids: string[];
}

export interface LazycatDevices {
  user_id: string;
  max_selection?: number;
  configured_device_ids?: string[];
  devices: { device_id: string; name: string; online: boolean }[];
}

export interface ProxyProfile {
  id: string;
  name: string;
  url: string;
  authenticated: boolean;
}

export interface ProxyProfileInput {
  name: string;
  url?: string;
  username?: string;
  password?: string;
}

export interface Target {
  channel?: string;
  account_id?: string;
  tag_selector?: string[];
  weight?: number;
  priority?: number;
}

export interface Retry {
  max_attempts?: number;
  backoff?: "fixed" | "exponential";
  base_delay?: number;
  max_delay?: number;
  jitter?: boolean;
  until_success?: boolean;
  ttl?: number;
}

export interface Strategy {
  mode?: Mode;
  retry?: Retry;
  success_criteria?: Criteria;
}

export interface Policy extends Strategy {
  mode: Mode;
  targets: Target[];
}

export interface Topic {
  name: string;
  description?: string | null;
  enabled: boolean;
  policy: Policy;
  protected?: boolean;
  default_tags?: string[];
  retention?: number | null;
}

export interface Subscription {
  id: string;
  subscriber_ref: string;
  account_id?: string | null;
  filter?: string[];
}

export interface Attachment {
  url: string;
  name?: string;
  content_type?: string;
}

export interface Message {
  title: string;
  body: string;
  format: Format;
  tags?: string[];
  level?: string;
  url?: string;
  attachments?: Attachment[];
  extras?: JsonObject;
}

export interface Publish extends Message {
  channels?: Target[];
  strategy?: Strategy;
  expire_at?: number;
  callback_url?: string;
  topic_password?: string;
}

export interface Acceptance {
  message_id: string;
  status: string;
}

export interface Attempt {
  n: number;
  started_at?: number | null;
  finished_at?: number | null;
  error_code?: string | null;
  error_msg?: string | null;
  latency?: number | null;
}

export interface Delivery {
  id: string;
  account_id: string;
  channel: string;
  status: string;
  next_retry_at?: number | null;
  attempts?: Attempt[];
}

export interface HistoryEntry {
  id: string;
  status: string;
  message: Message;
  topic?: string | null;
  created_at: number;
  deliveries?: Delivery[];
  inbox_deliveries?: number;
  inbox_recipient?: string | null;
}

export interface User {
  id: string;
  username: string;
  admin: boolean;
}

export interface PersonalProfile {
  nickname: string | null;
  avatar: string | null;
}

export interface SignIn {
  token: string;
  user: User;
}

export interface TotpStatus {
  enabled: boolean;
}

export interface TotpSetup {
  secret: string;
  uri: string;
  expires_at: number;
}

export interface InboxItem {
  audio_path?: string;
  id: number;
  from_username?: string | null;
  topic?: string | null;
  title: string;
  body: string;
  format: Format;
  created_at: number;
  read_at?: number | null;
}
