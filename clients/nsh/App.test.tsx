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

test("continues a draft across tabs and safely retries the same notification", async () => {
  const submissions: { key: string; body: string }[] = [];
  const app = await open("./App.tsx", {
    storage: chinesePreferences,
    platform: "linux",
    width: 1120,
    height: 1080,
    network: {
      ...baseNetwork(),
      [`${endpoints}/messages`]: { body: page() },
      [`POST ${endpoints}/send*`]: ({ headers, body }) => {
        submissions.push({
          key: headers["idempotency-key"] ?? headers["Idempotency-Key"],
          body: body ?? "",
        });
        if (submissions.length === 1)
          return {
            status: 503,
            body: { code: "unavailable", message: "服务器暂时无法响应" },
          };
        return { status: 202, body: { message_id: "m2", status: "pending" } };
      },
      [`${endpoints}/messages/m2`]: {
        body: {
          id: "m2",
          status: "success",
          message: { title: "Deploy", body: "Ready" },
          created_at: 1780000000000,
          deliveries: [
            { id: "d1", account_id: "a1", status: "success", channel: "ntfy" },
            {
              id: "d2",
              account_id: "a2",
              status: "failed",
              channel: "telegram",
            },
            {
              id: "d3",
              account_id: "a3",
              status: "pending",
              channel: "bark",
              next_retry_at: 1780000010000,
            },
          ],
        },
      },
    },
  });
  await login(app);
  await app.type("label:标题", "Deploy");
  await app.type("label:正文", "Ready");
  await app.press("显示发送选项");
  await app.type("label:有效期（秒）", "600");
  await app.press("role:button[发送通知]");
  await app.waitFor("服务器暂时无法响应");
  await app.press("role:button[投递]");
  await app.waitFor("还没有通知的投递记录。");
  await app.press("role:button[发送]");
  expect(app.value("label:标题")).toBe("Deploy");
  expect(app.value("label:正文")).toBe("Ready");
  expect(app.value("label:有效期（秒）")).toBe("600");
  await app.press("label:提交后等待结果");
  await app.press("role:button[发送通知]");
  await app.waitFor("等待重试");
  expect(app.shows("重放通知")).toBe(false);
  expect(submissions.length).toBe(2);
  expect(Boolean(submissions[0].key)).toBe(true);
  expect(submissions[0]).toEqual(submissions[1]);
  expect(
    app.requests().some((request) => request.url.endsWith("/send?wait=true")),
  ).toBe(true);
  await app.press("role:button[发送]");
  expect(app.value("label:标题")).toBe("");
  await app.press("查看上次投递");
  await app.waitFor("等待重试");
});

test("submits a notification with just a title or just a body", async () => {
  const sent: { title: string; body: string }[] = [];
  const app = await open("./App.tsx", {
    storage: chinesePreferences,
    platform: "linux",
    width: 1120,
    network: {
      ...baseNetwork(),
      [`POST ${endpoints}/send`]: ({ body }) => {
        const message = JSON.parse(body ?? "{}");
        sent.push({ title: message.title, body: message.body });
        return {
          status: 202,
          body: { message_id: String(sent.length), status: "pending" },
        };
      },
      [`${endpoints}/messages/*`]: () => ({
        body: {
          id: String(sent.length),
          created_at: 1780000000000,
          status: "success",
          message: sent[sent.length - 1],
          deliveries: [],
          inbox_deliveries: 2,
        },
      }),
    },
  });
  await login(app);
  expect(app.enabled("role:button[发送通知]")).toBe(false);
  await app.type("label:标题", "已到家");
  await app.press("role:button[发送通知]");
  await app.waitFor("已送达 2 个收件箱");
  await app.press("role:button[发送]");
  expect(app.enabled("role:button[发送通知]")).toBe(false);
  await app.type("label:正文", "到时见");
  await app.press("role:button[发送通知]");
  await app.waitFor("到时见");
  expect(sent).toEqual([
    { title: "已到家", body: "" },
    { title: "", body: "到时见" },
  ]);
});

test("clears private drafts when disconnecting and signing back in", async () => {
  const app = await open("./App.tsx", {
    storage: chinesePreferences,
    platform: "linux",
    width: 1120,
    network: {
      ...baseNetwork(),
      [`POST ${endpoints}/auth/logout`]: { status: 204 },
    },
  });
  await login(app);
  await app.type("label:标题", "Private draft");
  await app.type("label:正文", "Unsent message");
  await app.press("role:button[断开连接]");
  await app.waitFor("连接雁字服务器");
  expect(JSON.stringify(app.storage()).includes("Unsent message")).toBe(false);
  await login(app);
  expect(app.value("label:标题")).toBe("");
  expect(app.value("label:正文")).toBe("");
});

test("opens a reply to its sender, restores a body-only reply and shows its inbox receipt", async () => {
  const keys: string[] = [];
  const app = await open("./App.tsx", {
    storage: chinesePreferences,
    platform: "linux",
    width: 1120,
    network: {
      ...baseNetwork(),
      [`${endpoints}/inbox`]: {
        body: page([{ ...inboxItem, title: "" }], "1"),
      },
      [`${endpoints}/inbox?*`]: { body: page([], "1") },
      [`POST ${endpoints}/inbox/1/read`]: { status: 204 },
      [`POST ${endpoints}/inbox/send`]: ({ body, headers }) => {
        expect(JSON.parse(body ?? "{}")).toEqual({
          recipient: "bob",
          title: "",
          body: "Received",
          format: "text",
        });
        keys.push(headers["idempotency-key"] ?? headers["Idempotency-Key"]);
        if (keys.length === 1)
          return {
            status: 503,
            body: { code: "unavailable", message: "服务器暂时无法响应" },
          };
        return { status: 201, body: { id: 2, message_id: "m3" } };
      },
      [`${endpoints}/messages/m3`]: {
        body: {
          id: "m3",
          status: "success",
          message: { title: "", body: "Received" },
          created_at: 1780000000000,
          deliveries: [],
          inbox_deliveries: 1,
          inbox_recipient: "bob",
        },
      },
    },
  });
  await login(app);
  await app.waitFor("收件箱 (1)");
  await app.press("收件箱 (1)");
  await app.waitFor("Hello Alice");
  await app.waitFor("查看");
  await app.press("查看");
  await app.waitFor("Hello Alice");
  expect(
    app.requests().some((request) => request.url.endsWith("/1/read")),
  ).toBe(true);
  await app.press("回复 bob");
  await app.waitFor("发给 bob");
  expect(app.shows("label:收件人用户名")).toBe(false);
  await app.type("label:正文", "Received");
  await app.press("role:button[发送消息]");
  await app.waitFor("服务器暂时无法响应");
  await app.press("返回");
  await app.press("回复 bob");
  expect(app.value("label:正文")).toBe("Received");
  await app.press("role:button[发送消息]");
  await app.waitFor("消息已发送给 bob。");
  expect(Boolean(keys[0])).toBe(true);
  expect(keys).toEqual([keys[0], keys[0]]);
  await app.press("role:button[投递详情]");
  await app.waitFor("已送达 bob 的收件箱");
  expect(app.shows("渠道投递")).toBe(false);
  expect(app.shows("暂时没有渠道投递记录。")).toBe(false);
});

test("keeps reply recipients separate from new messages and locks the reply address", async () => {
  const app = await open("./App.tsx", {
    storage: chinesePreferences,
    platform: "linux",
    width: 1120,
    network: {
      ...baseNetwork(),
      [`${endpoints}/inbox`]: { body: page([inboxItem], "1") },
      [`${endpoints}/inbox?*`]: { body: page([], "1") },
      [`POST ${endpoints}/inbox/1/read`]: { status: 204 },
    },
  });
  await login(app);
  await app.waitFor("收件箱 (1)");
  await app.press("收件箱 (1)");
  await app.press("给用户发消息");
  await app.type("label:收件人用户名", "mira");
  await app.type("label:正文", "New message");
  await app.press("返回");
  await app.press("查看");
  await app.press("回复 bob");
  expect(app.shows("label:收件人用户名")).toBe(false);
  await app.waitFor("发给 bob");
  expect(app.value("label:正文")).toBe("");
  await app.type("label:正文", "Private reply");
  await app.press("返回");
  await app.press("返回");
  await app.press("给用户发消息");
  expect(app.value("label:收件人用户名")).toBe("mira");
  expect(app.value("label:正文")).toBe("New message");
  await app.press("返回");
  await app.press("查看");
  await app.press("回复 bob");
  await app.waitFor("发给 bob");
  expect(app.value("label:正文")).toBe("Private reply");
});

test("locks the Topic when opened from its page and lets general drafts change their target", async () => {
  let target = "";
  const app = await open("./App.tsx", {
    storage: chinesePreferences,
    platform: "linux",
    width: 1120,
    network: {
      ...baseNetwork(),
      [`${endpoints}/topics/ops/subscriptions`]: { body: page() },
      [`POST ${endpoints}/topics/ops/publish`]: ({ body }) => {
        const sent = JSON.parse(body ?? "{}");
        expect(sent.topic_password).toBe("fixture-topic-password");
        expect(sent.body).toBe("For operations");
        target = "ops";
        return {
          status: 202,
          body: { message_id: "topic1", status: "pending" },
        };
      },
      [`${endpoints}/messages/topic1`]: {
        body: {
          id: "topic1",
          topic: "ops",
          created_at: 1780000000000,
          status: "success",
          message: { title: "", body: "For operations", format: "text" },
          deliveries: [],
        },
      },
    },
  });
  await login(app);
  await app.waitFor("role:button[发送通知]");
  await app.press("label:主题");
  await app.press("ops");
  await app.type("label:正文", "General draft");
  await app.press("role:button[主题]");
  await app.waitFor("ops");
  await app.press("查看");
  await app.press("发布通知");
  expect(app.shows("label:主题")).toBe(false);
  expect(app.value("label:正文")).toBe("");
  await app.type("label:正文", "For operations");
  await app.press("返回");
  await app.press("发布通知");
  expect(app.shows("label:主题")).toBe(false);
  expect(app.value("label:正文")).toBe("For operations");
  await app.type("label:主题密码（如需）", "fixture-topic-password");
  await app.press("role:button[发送通知]");
  await app.waitFor("已成功");
  expect(target).toBe("ops");
  await app.press("role:button[发送]");
  expect(app.shows("label:主题")).toBe(true);
  expect(app.value("label:正文")).toBe("General draft");
});

test("supports a legacy inbox receipt without a message link", async () => {
  const app = await open("./App.tsx", {
    storage: chinesePreferences,
    platform: "linux",
    width: 1120,
    network: {
      ...baseNetwork(),
      [`POST ${endpoints}/inbox/send`]: { status: 201, body: { id: 2 } },
    },
  });
  await login(app);
  await app.press("role:button[收件箱]");
  await app.press("给用户发消息");
  await app.type("label:收件人用户名", "bob");
  await app.type("label:标题", "Reply");
  await app.type("label:正文", "Received");
  await app.press("role:button[发送消息]");
  await app.waitFor("消息已发送给 bob。");
  expect(app.shows("role:button[投递详情]")).toBe(false);
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

const proxyProfile = {
  id: "p1",
  name: "Office egress",
  url: "https://proxy.example.test:8443",
  authenticated: true,
};

const chinesePreferences = {
  "anser.preferences": JSON.stringify({
    language: "zh-CN",
    appearance: "system",
  }),
};

test("admin manages reusable proxy profiles without reading credentials", async () => {
  let profile: typeof proxyProfile | undefined;
  let inUse = true;
  const app = await open("./App.tsx", {
    platform: "linux",
    storage: chinesePreferences,
    width: 1120,
    height: 900,
    network: {
      ...baseNetwork(),
      [`${endpoints}/proxies`]: () => ({
        body: page(profile ? [profile] : []),
      }),
      [`POST ${endpoints}/proxies`]: ({ body }) => {
        expect(JSON.parse(body ?? "{}")).toEqual({
          name: proxyProfile.name,
          url: proxyProfile.url,
          username: "fixture-user",
          password: "fixture-secret",
        });
        profile = proxyProfile;
        return { status: 201, body: profile };
      },
      [`PUT ${endpoints}/proxies/p1`]: ({ body }) => {
        expect(JSON.parse(body ?? "{}")).toEqual({ name: "Shared egress" });
        profile = { ...proxyProfile, name: "Shared egress" };
        return { body: profile };
      },
      [`DELETE ${endpoints}/proxies/p1`]: () => {
        if (inUse)
          return {
            status: 409,
            body: { code: "proxy_in_use", message: "profile in use" },
          };
        profile = undefined;
        return { status: 204 };
      },
    },
  });
  await login(app);
  await app.press("role:button[账号]");
  await app.press("代理配置");
  await app.press("添加代理配置");
  await app.type("label:配置名称", proxyProfile.name);
  await app.type(
    "label:代理地址",
    "https://embedded:password@proxy.example.test:8443",
  );
  await app.press("保存代理配置");
  await app.waitFor(
    "请输入 HTTP 或 HTTPS 代理地址，地址中不要包含凭据、路径、查询参数或片段。",
  );
  expect(
    app
      .requests()
      .filter(
        (request) =>
          request.method === "POST" && request.url.endsWith("/proxies"),
      ).length,
  ).toBe(0);
  await app.clear("label:代理地址");
  await app.type("label:代理地址", proxyProfile.url);
  await app.press("使用代理认证");
  await app.type("label:代理用户名", "fixture-user");
  await app.type("label:代理密码", "fixture-secret");
  await app.press("保存代理配置");
  await app.waitFor(proxyProfile.name);
  await app.press("查看");
  expect(app.shows("label:代理密码")).toBe(false);

  await app.clear("label:配置名称");
  await app.type("label:配置名称", "Shared egress");
  await app.press("保存代理配置");
  await app.waitFor("Shared egress");
  await app.press("查看");
  app.onDialog(() => "删除代理配置");
  await app.press("删除代理配置");
  await app.waitFor("此配置正在使用。请先解除渠道账号与它的关联。");
  inUse = false;
  await app.press("删除代理配置");
  await app.waitFor("尚无代理配置。添加后可在多个渠道账号中复用。");
});

test("links and removes a proxy profile while preserving the saved account config", async () => {
  let proxyId: string | null = null;
  const existing = {
    id: "a1",
    channel: "ntfy",
    name: "Operations",
    enabled: true,
  };
  const app = await open("./App.tsx", {
    platform: "linux",
    storage: chinesePreferences,
    width: 1120,
    height: 1080,
    network: {
      ...baseNetwork(),
      [`${endpoints}/channels`]: {
        body: page([
          {
            ...channel,
            can_manage: true,
            config_schema: {
              properties: {
                topic: { type: "string" },
                proxy: { type: "string", format: "uri" },
              },
            },
          },
        ]),
      },
      [`${endpoints}/accounts`]: () => ({
        body: page([{ ...existing, proxy_id: proxyId }]),
      }),
      [`${endpoints}/proxies`]: { body: page([proxyProfile]) },
      [`PUT ${endpoints}/accounts/a1`]: ({ body }) => {
        const input = JSON.parse(body ?? "{}");
        expect(input.proxy_id).toBe(proxyId === null ? proxyProfile.id : null);
        expect("config" in input).toBe(false);
        proxyId = input.proxy_id;
        return { body: { ...existing, proxy_id: proxyId } };
      },
    },
  });
  await login(app);
  await app.press("role:button[账号]");
  await app.waitFor("Operations");
  await app.press("查看");
  await app.press("替换已保存的配置");
  await app.waitFor("label:HTTP 代理地址");
  await app.press("label:出站代理");
  await app.press(proxyProfile.name);
  expect(app.shows("label:HTTP 代理地址")).toBe(false);
  await app.press("替换已保存的配置");
  await app.press("保存账号");
  await app.waitFor("Operations");
  expect(proxyId).toBe(proxyProfile.id);

  await app.press("查看");
  await app.waitFor(proxyProfile.name);
  await app.press("label:出站代理");
  await app.press("使用账号连接设置");
  await app.press("保存账号");
  await app.waitFor("Operations");
  expect(proxyId).toBe(null);
});
