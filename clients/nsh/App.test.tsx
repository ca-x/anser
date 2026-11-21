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
  await app.press("role:button[Topic]");
  await app.waitFor("ops");
  await app.press("查看");
  await app.press("添加订阅");
  await app.type("label:Topic 密码", "topic-fixture");
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
  await app.waitFor("连接 Anser 服务器");
  await app.press("偏好设置");
  await app.press("label:语言");
  await app.press("English");
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
