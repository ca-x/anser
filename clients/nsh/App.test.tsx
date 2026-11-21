import { expect, open, test, type App, type OpenOptions } from "nsh/test";

const origin = "https://anser.example.test";
const endpoints = `${origin}/v1`;
const page = (items: unknown[] = [], next_cursor: string | null = null) => ({
  items,
  next_cursor,
});
const user = { id: "u1", username: "alice", admin: true };
const channel = {
  id: "ntfy",
  display_name: "ntfy",
  config_schema: {},
  capabilities: { formats: ["text"] },
};
const pairingCode = "a".repeat(43);
const topic = {
  name: "ops",
  protected: true,
  enabled: true,
  policy: { mode: "broadcast", targets: [] },
};
const inboxItem = {
  id: 1,
  from_username: "bob",
  title: "Incoming test",
  body: "Hello Alice",
  created_at: 1780000000000,
  format: "text",
};

function baseNetwork(): Exclude<
  OpenOptions["network"],
  "live" | null | undefined
> {
  return {
    [`POST ${endpoints}/auth/login`]: ({ body }) => {
      expect(JSON.parse(body ?? "{}")).toEqual({
        username: "alice",
        password: "fixture-password",
      });
      return { body: { token: "fixture-token", user } };
    },
    [`${endpoints}/channels`]: ({ headers }) => {
      expect(headers.authorization ?? headers.Authorization).toBe(
        "Bearer fixture-token",
      );
      return { body: page([channel]) };
    },
    [`${endpoints}/accounts`]: { body: page() },
    [`${endpoints}/topics`]: { body: page([topic]) },
    [`${endpoints}/inbox`]: { body: page([], "0") },
    [`${endpoints}/inbox?*`]: { body: page([], "0") },
  };
}

async function login(app: App, url = origin) {
  await app.type("id:server-address", url);
  await app.type("id:username", "alice");
  await app.type("id:password", "fixture-password");
  await app.press("role:button[连接]");
  if (url === origin) await app.waitFor("role:button[发送通知]");
}

test("blocks a remote plaintext login before any request", async () => {
  const app = await open("./App.tsx", {
    platform: "linux",
    locale: "zh-Hans-CN",
  });
  await login(app, "http://anser.example.test");
  await app.waitFor("请为远程服务器使用 HTTPS。HTTP 仅供本机连接。");
  expect(app.requests()).toEqual([]);
});

test("logs in and sends a notification with an idempotency key", async () => {
  const app = await open("./App.tsx", {
    locale: "zh-CN",
    platform: "linux",
    width: 1120,
    height: 760,
    network: {
      ...baseNetwork(),
      [`POST ${endpoints}/send`]: ({ body, headers }) => {
        expect(JSON.parse(body ?? "{}")).toEqual({
          title: "Deployment",
          body: "Done",
          format: "text",
          level: "info",
        });
        expect(
          Boolean(headers["idempotency-key"] ?? headers["Idempotency-Key"]),
        ).toBe(true);
        return { status: 202, body: { message_id: "m1", status: "pending" } };
      },
      [`${endpoints}/messages/m1`]: {
        body: {
          id: "m1",
          status: "success",
          message: { title: "Deployment", body: "Done", format: "text" },
          created_at: 1780000000000,
          deliveries: [
            {
              id: "d1",
              account_id: "a1",
              status: "success",
              channel: "ntfy",
              attempts: [{ n: 1, latency: 90 }],
            },
          ],
        },
      },
    },
  });
  await login(app);
  await app.waitFor("正在加载…", { state: "gone" });
  await app.type("label:标题", "Deployment");
  await app.type("label:正文", "Done");
  await app.press("role:button[发送通知]");
  await app.waitFor("Deployment");
  await app.waitFor("已成功");
  await app.press("查看 1 次尝试");
  await app.waitFor("耗时：90 毫秒");
});

test("previews a QR deep link and exchanges its code after explicit confirmation", async () => {
  const app = await open("./App.tsx", {
    locale: "zh-CN",
    urlScheme: `anser://connect?server=${encodeURIComponent(origin)}&code=${pairingCode}`,
    network: {
      ...baseNetwork(),
      [`POST ${endpoints}/auth/pair/exchange`]: ({ body }) => {
        expect(JSON.parse(body ?? "{}")).toEqual({ code: pairingCode });
        return { body: { token: "fixture-token", user } };
      },
    },
  });
  await app.waitFor("使用配对码连接");
  expect(app.requests()).toEqual([]);
  app.onDialog(() => "连接此服务器");
  await app.press("使用配对码连接");
  await app.waitFor("role:button[发送通知]");
  expect(
    app
      .requests()
      .some((request) => request.url.endsWith("/auth/pair/exchange")),
  ).toBe(true);
});

test("receives and marks a direct message as read, then addresses a reply by username", async () => {
  const app = await open("./App.tsx", {
    locale: "zh-CN",
    platform: "linux",
    width: 1120,
    network: {
      ...baseNetwork(),
      [`${endpoints}/inbox`]: { body: page([inboxItem], "1") },
      [`${endpoints}/inbox?*`]: { body: page([], "1") },
      [`POST ${endpoints}/inbox/1/read`]: { status: 204 },
      [`POST ${endpoints}/inbox/send`]: ({ body }) => {
        expect(JSON.parse(body ?? "{}")).toEqual({
          recipient: "bob",
          title: "Reply",
          body: "Received",
          format: "text",
        });
        return { status: 201, body: { id: "i2" } };
      },
    },
  });
  await login(app);
  await app.waitFor("收件箱 (1)");
  await app.press("收件箱 (1)");
  await app.press("查看");
  await app.waitFor("Hello Alice");
  expect(
    app.requests().some((request) => request.url.endsWith("/1/read")),
  ).toBe(true);
  await app.press("返回");
  await app.press("给用户发消息");
  await app.type("label:收件人用户名", "bob");
  await app.type("label:标题", "Reply");
  await app.type("label:正文", "Received");
  await app.press("role:button[发送消息]");
  await app.waitFor("消息已发送给 bob。");
});

test("subscribes to a protected Topic with a separate password", async () => {
  let subscribed = false;
  const app = await open("./App.tsx", {
    locale: "zh-CN",
    platform: "linux",
    width: 1120,
    network: {
      ...baseNetwork(),
      [`${endpoints}/topics/ops/subscriptions`]: () => ({
        body: page(
          subscribed ? [{ id: "s1", subscriber_ref: "alice", filter: [] }] : [],
        ),
      }),
      [`POST ${endpoints}/topics/ops/subscriptions`]: ({ body }) => {
        expect(JSON.parse(body ?? "{}")).toEqual({
          subscriber_ref: "alice",
          filter: [],
          password: "topic-fixture",
        });
        subscribed = true;
        return {
          status: 201,
          body: { id: "s1", subscriber_ref: "alice", filter: [] },
        };
      },
    },
  });
  await login(app);
  await app.press("role:button[主题]");
  await app.waitFor("ops");
  await app.press("查看");
  await app.press("添加订阅");
  await app.type("label:主题密码", "topic-fixture");
  await app.press("保存订阅");
  await app.waitFor("退订");
  expect(subscribed).toBe(true);
});

test("switches language and appearance, then restores the saved preferences", async () => {
  const options: OpenOptions = {
    platform: "linux",
    width: 1120,
    height: 1030,
    locale: "zh-Hans-CN",
    colorScheme: "light",
    storage: {
      "anser.preferences": JSON.stringify({
        language: "zh-CN",
        appearance: "system",
      }),
    },
  };
  const app = await open("./App.tsx", options);
  await app.waitFor("连接雁字服务器");
  await app.press("偏好设置");
  await app.press("label:语言");
  await app.press("英文");
  await app.waitFor("Connect to an Anser server");

  await app.press("label:Appearance");
  await app.press("Dark");
  expect(app.viewStyle("id:app-background")?.backgroundColor).toBe("#171615ff");

  await app.press("label:Appearance");
  await app.press("Light");
  expect(app.viewStyle("id:app-background")?.backgroundColor).toBe("#f8f6f2ff");

  await app.press("label:Appearance");
  await app.press("Follow system");
  expect(app.viewStyle("id:app-background")?.backgroundColor).toBe("#f8f6f2ff");

  await app.press("label:Appearance");
  await app.press("Dark");
  const saved = JSON.parse(app.storage()["anser.preferences"]);
  expect(saved).toEqual({ language: "en", appearance: "dark" });

  const relaunched = await open("./App.tsx", {
    ...options,
    storage: app.storage(),
  });
  await relaunched.waitFor("Connect to an Anser server");
  expect(relaunched.viewStyle("id:app-background")?.backgroundColor).toBe(
    "#171615ff",
  );
});

const lark = {
  ...channel,
  id: "feishu",
  display_name: "飞书 / Lark",
  enabled: true,
  available: true,
  can_manage: true,
};
const serverChan = {
  ...channel,
  id: "serverchan",
  display_name: "Server酱",
  enabled: true,
  available: true,
  can_manage: true,
  config_schema: {
    properties: {
      sendkey: { type: "string", writeOnly: true },
      version: { enum: ["turbo", "3"] },
    },
    required: ["sendkey"],
  },
};

test("manages plugin runtime and configures an account for that plugin", async () => {
  let enabled = true;
  let reloaded = false;
  const accounts: unknown[] = [];
  const plugin = () => ({
    ...serverChan,
    enabled,
    available: enabled,
  });
  const app = await open("./App.tsx", {
    locale: "zh-CN",
    platform: "linux",
    width: 1120,
    height: 1160,
    network: {
      ...baseNetwork(),
      [`${endpoints}/channels`]: () => ({ body: page([lark, plugin()]) }),
      [`${endpoints}/channels/serverchan`]: () => ({ body: plugin() }),
      [`PUT ${endpoints}/channels/serverchan/runtime`]: ({ body }) => {
        const change = JSON.parse(body ?? "{}");
        if (change.reload) {
          expect(change).toEqual({ reload: true });
          reloaded = true;
        } else {
          expect(change).toEqual({ enabled: !enabled });
          enabled = change.enabled;
        }
        return { body: { id: "serverchan", enabled, available: enabled } };
      },
      [`${endpoints}/accounts?channel=serverchan`]: () => ({
        body: page(accounts),
      }),
      [`POST ${endpoints}/accounts`]: ({ body }) => {
        const input = JSON.parse(body ?? "{}");
        expect(input.channel).toBe("serverchan");
        expect(input.config).toEqual({
          sendkey: "SCT_fixture",
          version: "turbo",
        });
        const account = {
          id: "s1",
          channel: input.channel,
          name: input.name,
          enabled: true,
        };
        accounts.push(account);
        return { status: 201, body: account };
      },
    },
  });
  await login(app);
  await app.press("role:button[账号]");
  await app.press("渠道插件");
  await app.waitFor("text:飞书");
  await app.waitFor("text:Server酱");
  expect(app.texts().includes("飞书 / Lark")).toBe(false);
  await app.press("label:配置Server酱");
  await app.waitFor("此插件尚未配置账号。");

  app.onDialog(() => "停用插件");
  await app.press("停用插件");
  await app.waitFor("已停用");
  expect(enabled).toBe(false);
  expect(app.enabled("role:button[添加账号]")).toBe(false);

  await app.press("启用插件");
  await app.waitFor("已启用");
  expect(enabled).toBe(true);
  await app.press("重载插件");
  await app.waitFor("插件已重载。");
  expect(reloaded).toBe(true);

  await app.press("role:button[添加账号]");
  await app.type("label:账号名称", "Operations");
  await app.type("label:发送密钥（必填）", "SCT_fixture");
  await app.press("label:服务版本");
  await app.press("Turbo");
  await app.press("保存账号");
  await app.waitFor("Operations");
  expect(app.texts().includes("插件运行状态")).toBe(true);
});

test("uses English provider names and exposes plugin management to a global admin key", async () => {
  const app = await open("./App.tsx", {
    locale: "en",
    platform: "linux",
    width: 1120,
    network: {
      ...baseNetwork(),
      [`${endpoints}/auth/me`]: { status: 403, body: { code: "forbidden" } },
      [`${endpoints}/channels`]: { body: page([lark, serverChan]) },
    },
  });
  await app.type("id:server-address", origin);
  await app.press("label:Sign-in method");
  await app.press("API Key");
  await app.type("label:API Key", "fixture-token");
  await app.press("role:button[Connect]");
  await app.press("role:button[Accounts]");
  await app.press("Channel plugins");
  await app.waitFor("text:Lark");
  await app.waitFor("text:ServerChan");
  expect(app.texts().includes("飞书 / Lark")).toBe(false);
  expect(app.texts().includes("Server酱")).toBe(false);
});

test("hides plugin management from a member session", async () => {
  const app = await open("./App.tsx", {
    locale: "zh-CN",
    platform: "linux",
    width: 1120,
    network: {
      ...baseNetwork(),
      [`POST ${endpoints}/auth/login`]: {
        body: { token: "fixture-token", user: { ...user, admin: false } },
      },
      [`${endpoints}/channels`]: {
        body: page([{ ...lark, can_manage: false }]),
      },
    },
  });
  await login(app);
  expect(app.shows("role:button[账号]")).toBe(false);
  expect(app.shows("渠道插件")).toBe(false);
});

test("prompts for two-factor verification after password sign-in", async () => {
  let attempts = 0;
  const recoveryCode = "ABCDEFG-HJKLMNP-QRSTUV-WXYZ23";
  const app = await open("./App.tsx", {
    locale: "zh-CN",
    storage: {
      "anser.preferences": JSON.stringify({
        language: "zh-CN",
        appearance: "system",
      }),
    },
    platform: "linux",
    width: 1120,
    network: {
      ...baseNetwork(),
      [`POST ${endpoints}/auth/login`]: ({ body }) => {
        const code = [undefined, "123456", recoveryCode][attempts++];
        expect(JSON.parse(body ?? "{}")).toEqual({
          username: "alice",
          password: "fixture-password",
          ...(code === undefined ? {} : { code }),
        });
        if (code === undefined)
          return {
            status: 401,
            body: { code: "totp_required", message: "enter a code" },
          };
        if (code !== recoveryCode)
          return {
            status: 401,
            body: { code: "invalid_totp", message: "invalid code" },
          };
        return { body: { token: "fixture-token", user } };
      },
    },
  });
  await app.type("id:server-address", origin);
  await app.type("id:username", "alice");
  await app.type("id:password", "fixture-password");
  await app.press("role:button[连接]");
  await app.waitFor("请输入验证器应用生成的验证码，或使用恢复码。");
  expect(app.enabled("role:button[连接]")).toBe(false);
  await app.type("id:verification-code", "123456");
  await app.press("role:button[连接]");
  await app.waitFor("验证码无效或已被使用。");
  expect(app.value("id:verification-code")).toBe("");
  await app.type("id:verification-code", recoveryCode);
  await app.press("role:button[连接]");
  await app.waitFor("role:button[发送通知]");
  expect(attempts).toBe(3);
});

test("sets up and disables two-factor authentication for the signed-in user", async () => {
  const secret = "JBSWY3DPEHPK3PXP";
  const recoveryCodes = [
    "ABCDEFG-HJKLMNP-QRSTUV-WXYZ23",
    "TUVWXYZ-234567A-BCDEFG-HJKLMN",
  ];
  const member = { ...user, admin: false };
  let enabled = false;
  const app = await open("./App.tsx", {
    locale: "zh-CN",
    storage: {
      "anser.preferences": JSON.stringify({
        language: "zh-CN",
        appearance: "system",
      }),
    },
    platform: "linux",
    width: 1120,
    height: 1030,
    network: {
      ...baseNetwork(),
      [`POST ${endpoints}/auth/login`]: {
        body: { token: "fixture-token", user: member },
      },
      [`${endpoints}/auth/totp`]: () => ({ body: { enabled } }),
      [`POST ${endpoints}/auth/totp/setup`]: ({ body }) => {
        expect(JSON.parse(body ?? "{}")).toEqual({
          password: "fixture-password",
        });
        return {
          body: {
            secret,
            uri: `otpauth://totp/Anser:alice?secret=${secret}`,
            expires_at: 1795276800000,
          },
        };
      },
      [`POST ${endpoints}/auth/totp/confirm`]: ({ body }) => {
        expect(JSON.parse(body ?? "{}")).toEqual({ code: "123456" });
        enabled = true;
        return { body: { enabled, recovery_codes: recoveryCodes } };
      },
      [`POST ${endpoints}/auth/totp/disable`]: ({ body }) => {
        expect(JSON.parse(body ?? "{}")).toEqual({
          password: "fixture-password",
          code: recoveryCodes[0],
        });
        enabled = false;
        return { body: { enabled } };
      },
    },
  });
  await login(app);
  await app.press("偏好设置");
  await app.press("账号安全");
  await app.press("设置双重验证");
  await app.type("label:当前密码", "fixture-password");
  await app.press("继续");
  await app.waitFor(secret);
  await app.press("复制验证器密钥");
  expect(app.clipboard()).toBe(secret);
  await app.type("label:验证器验证码", "123456");
  await app.press("验证并启用");
  await app.waitFor("恢复码");
  expect(app.shows(secret)).toBe(false);
  await app.press("复制恢复码");
  expect(app.clipboard()).toBe(recoveryCodes.join("\n"));
  await app.press("返回");
  await app.press("账号安全");
  await app.waitFor("停用双重验证");
  expect(app.shows("复制恢复码")).toBe(false);
  expect(app.shows(secret)).toBe(false);
  await app.press("停用双重验证");
  await app.type("label:当前密码", "fixture-password");
  await app.type("label:验证器验证码或恢复码", recoveryCodes[0]);
  await app.press("确认停用");
  await app.waitFor("设置双重验证");
  expect(enabled).toBe(false);
});
