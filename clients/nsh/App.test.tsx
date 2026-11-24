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
    [`${endpoints}/auth/profile`]: { body: { nickname: null, avatar: null } },
    [`${endpoints}/topics`]: { body: page([topic]) },
    [`${endpoints}/inbox`]: { body: page([], "0") },
    [`${endpoints}/inbox?*`]: { body: page([], "0") },
  };
}

async function login(app: App, url = origin) {
  if (app.shows("id:server-address")) await app.type("id:server-address", url);
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

for (const method of ["deep link", "pasted link"] as const) {
  test(`previews a pairing ${method} and exchanges its code after confirmation`, async () => {
    const link = `anser://connect?server=${encodeURIComponent(origin)}&code=${pairingCode}`;
    const app = await open("./App.tsx", {
      storage: chinesePreferences,
      ...(method === "deep link" ? { urlScheme: link } : {}),
      network: {
        ...baseNetwork(),
        [`POST ${endpoints}/auth/pair/exchange`]: ({ body }) => {
          expect(JSON.parse(body ?? "{}")).toEqual({ code: pairingCode });
          return { body: { token: "fixture-token", user } };
        },
      },
    });
    if (method === "pasted link") {
      await app.press("导入连接链接");
      await app.type("label:连接链接", link);
      await app.press("预览服务器");
    }
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
}

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

test("manages saved server names, defaults, and the desktop sidebar", async () => {
  const other = "https://cloud.example.test";
  const app = await open("./App.tsx", {
    platform: "linux", locale: "zh-CN", width: 1120, height: 900,
    storage: chinesePreferences,
    network: baseNetwork(),
  });
  await login(app);
  await app.press("role:button[服务器]");
  await app.press("label:编辑 anser.example.test");
  expect(app.value("label:服务器地址")).toBe(origin);
  await app.type("label:服务器备注", "家庭服务");
  await app.press("保存服务器");
  await app.press("添加服务器");
  await app.type("label:服务器备注", "云端服务");
  await app.type("label:服务器地址", other);
  await app.press("保存服务器");
  expect(app.texts()).not.toContain(other);
  expect(app.texts()).not.toContain(origin);
  await app.press("role:checkbox[家庭服务]");
  await app.press("role:checkbox[云端服务]");
  await app.waitUntil(() => {
    const value = JSON.parse(app.storage()["anser.servers"] ?? "{}");
    return value.defaults?.length === 2;
  });
  expect(JSON.parse(app.storage()["anser.servers"])).toEqual({
    profiles: [{ origin, name: "家庭服务" }, { origin: other, name: "云端服务" }],
    defaults: [origin, other],
  });
  expect(app.layout("id:desktop-sidebar")?.width).toBe(208);
  await app.press("收起侧栏");
  expect(app.layout("id:desktop-sidebar")?.width).toBe(64);
  await app.press("role:button[发送]");
  await app.waitFor("发送服务器");
  expect(String(app.accessibility("role:checkbox[家庭服务]")?.checked)).toBe("true");
  expect(String(app.accessibility("role:checkbox[云端服务]")?.checked)).toBe("true");
  expect(app.enabled("role:button[发送通知]")).toBe(false);
  await app.press("展开侧栏");
  expect(app.layout("id:desktop-sidebar")?.width).toBe(208);
});

test("signs in separately and retries only the failed server for the same notification", async () => {
  const other = "https://cloud.example.test";
  const received: { origin: string; key: string | undefined }[] = [];
  let attempts = 0;
  const app = await open("./App.tsx", {
    platform: "linux", locale: "zh-CN", width: 1120, height: 980,
    storage: {
      ...chinesePreferences,
      "anser.servers": JSON.stringify({
        profiles: [{ origin, name: "家庭服务" }, { origin: other, name: "云端服务" }],
        defaults: [origin, other],
      }),
    },
    network: {
      ...baseNetwork(),
      [`POST ${other}/v1/auth/login`]: ({ body }) => {
        expect(JSON.parse(body ?? "{}")).toEqual({ username: "bob", password: "cloud-fixture" });
        return { body: { token: "cloud-token", user: { ...user, username: "bob" } } };
      },
      [`${other}/v1/channels`]: { body: page([channel]) },
      [`POST ${endpoints}/send`]: ({ body, headers }) => {
        expect(headers.authorization ?? headers.Authorization).toBe("Bearer fixture-token");
        expect(JSON.parse(body ?? "{}").title).toBe("Different servers");
        received.push({ origin, key: headers["idempotency-key"] ?? headers["Idempotency-Key"] });
        return { status: 202, body: { message_id: "m-home", status: "pending" } };
      },
      [`POST ${other}/v1/send`]: ({ body, headers }) => {
        expect(headers.authorization ?? headers.Authorization).toBe("Bearer cloud-token");
        expect(JSON.parse(body ?? "{}").title).toBe("Different servers");
        received.push({ origin: other, key: headers["idempotency-key"] ?? headers["Idempotency-Key"] });
        attempts += 1;
        return attempts === 1
          ? { status: 503, body: { code: "unavailable", message: "Temporary failure" } }
          : { status: 202, body: { message_id: "m-cloud", status: "pending" } };
      },
    },
  });
  await login(app);
  await app.type("label:标题", "Different servers");
  expect(app.enabled("role:button[发送通知]")).toBe(false);
  await app.press("登录 云端服务");
  expect(app.shows("id:server-address")).toBe(false);
  await app.type("id:username", "bob");
  await app.type("id:password", "cloud-fixture");
  await app.press("role:button[连接]");
  await app.waitFor("发送服务器");
  expect(app.value("label:标题")).toBe("Different servers");
  await app.press("role:button[发送通知]");
  await app.waitFor("提交结果");
  await app.waitFor("用相同草稿再次发送即可重试失败项，已入队的服务器会自动跳过。");
  await app.press("role:button[发送通知]");
  await app.waitUntil(() => app.count("text:已入队") === 2);
  expect(received.filter((item) => item.origin === origin).length).toBe(1);
  const remote = received.filter((item) => item.origin === other);
  expect(remote.length).toBe(2);
  expect(Boolean(remote[0].key)).toBe(true);
  expect(remote[0].key).toBe(remote[1].key);
  expect(JSON.stringify(app.storage()).includes("cloud-token")).toBe(false);
  expect(JSON.stringify(app.storage()).includes("cloud-fixture")).toBe(false);
  await app.press("role:button[服务器]");
  await app.press("label:打开 云端服务");
  await app.waitFor("bob");
  await app.press("role:button[服务器]");
  await app.press("label:打开 家庭服务");
  await app.waitFor("alice");
});

test("renders an inbox interaction and submits a declared response", async () => {
  const app = await open("./App.tsx", {
    storage: chinesePreferences,
    platform: "linux",
    width: 430,
    network: {
      ...baseNetwork(),
      [`${endpoints}/inbox`]: { body: page([{ ...inboxItem, interaction_id: "question1" }], "1") },
      [`${endpoints}/inbox?*`]: { body: page([], "1") },
      [`POST ${endpoints}/inbox/1/read`]: { status: 204 },
      [`${endpoints}/inbox/1/interaction`]: { body: {
        id: "question1", status: "pending", expires_at: 1893459600000, reply: null,
        form: { buttons: [{ label: "同意", value: "approve" }],
          input: { name: "note", label: "附上原因", submit: "发送原因", placeholder: "可输入原因", multiline: false, max_length: 4 },
          select: null },
      }},
      [`POST ${endpoints}/inbox/1/interaction`]: ({ body }) => {
        expect(JSON.parse(body ?? "{}")).toEqual({ kind: "action", value: "approve" });
        return { body: { id: "question1", status: "answered", expires_at: 1893459600000,
          reply: { kind: "action", value: "approve" } } };
      },
    },
  });
  await login(app);
  await app.waitFor("收件箱 (1)");
  await app.press("收件箱 (1)");
  await app.waitFor("Incoming test");
  await app.press("查看");
  await app.waitFor("同意");
  await app.type("label:附上原因", "超过四个字符");
  await app.waitFor("请填写不超过 4 个字符。");
  await app.press("同意");
  await app.waitFor("回复已提交。");
  expect(app.shows("同意")).toBe(false);
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

test("restores the app theme on web when Omarchy was previously selected", async () => {
  const app = await open("./App.tsx", {
    platform: "web",
    locale: "en",
    colorScheme: "light",
    storage: {
      "anser.preferences": JSON.stringify({
        language: "en",
        appearance: "omarchy",
      }),
    },
  });
  await app.waitFor("Connect to an Anser server");
  expect(app.viewStyle("id:app-background")?.backgroundColor).toBe("#f8f6f2ff");
  await app.press("Preferences");
  await app.press("label:Appearance");
  expect(app.texts()).not.toContain("Omarchy desktop theme");
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
      [`${endpoints}/plugins`]: {
        body: page([
          { ...lark, kind: "channel" },
          { ...serverChan, kind: "channel" },
          { id: "tls-fixture", kind: "task", display_name: "Certificate monitor", available: true, enabled: true,
            version: "0.1.0", config_schema: {
              "x-anser-ui": { label: { en: "Certificate monitor", "zh-CN": "证书监控" } },
            },
          },
          { id: "audio-fixture", kind: "content_transform", display_name: "Speech", available: true, enabled: true,
            config_schema: { "x-anser-ui": { label: { en: "Speech", "zh-CN": "语音合成" } } },
          },
        ]),
      },
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
  await app.press("插件管理");
  await app.waitFor("text:飞书");
  await app.waitFor("text:Server酱");
  await app.waitFor("任务插件");
  await app.waitFor("证书监控");
  await app.waitFor("内容转换插件");
  await app.waitFor("语音合成");
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

test("configures a transform with saved credentials and provider voice choices", async () => {
  const path = `${endpoints}/plugins/content_transform/openai-tts`;
  let settings = {
    config: { server_url: "https://speech.example.test", model: "tts-1", voice: "alloy", audio_retention_days: 7 },
    saved_credentials: ["api_key"], revision: "fixture",
  };
  let submitted: Record<string, unknown> | undefined;
  const app = await open("./App.tsx", {
    platform: "linux",
    storage: chinesePreferences,
    width: 1120,
    height: 960,
    network: {
      ...baseNetwork(),
      [`${endpoints}/plugins`]: { body: page([{
        id: "openai-tts", kind: "content_transform", display_name: "TTS", available: true, enabled: true,
        config_schema: {
          "x-anser-ui": {
            label: { "zh-CN": "文本转语音" }, persistent_settings: true,
            account_editor: { fields: ["server_url", "model", "voice"], credentials: { api_key: ["server_url"] } },
          },
          properties: {
            server_url: { type: "string" },
            api_key: { type: "string", writeOnly: true },
            model: { type: "string" },
            audio_retention_days: { type: "integer", "x-anser-ui": { label: { "zh-CN": "音频保留天数" } } },
            voice: { type: "string", "x-anser-ui": {
              label: { "zh-CN": "音色" }, dynamic_options: { fields: ["server_url", "api_key", "model"] },
            } },
          },
          required: ["server_url", "api_key", "model", "voice"],
        },
      }]) },
      [`GET ${path}/config`]: () => ({ body: settings }),
      [`PUT ${path}/config`]: ({ body }) => {
        submitted = JSON.parse(body ?? "{}");
        settings = { ...settings, config: JSON.parse(body ?? "{}").config, revision: "updated" };
        return { body: settings };
      },
      [`POST ${path}/options/voice`]: ({ body }) => {
        expect(JSON.parse(body ?? "{}")).toEqual({
          config: { server_url: "https://speech.example.test", model: "tts-1" }, config_revision: settings.revision,
        });
        return { body: page([{ value: "alloy", label: "Alloy" }, { value: "cedar", label: "Cedar" }]) };
      },
    },
  });
  await login(app);
  await app.press("role:button[账号]");
  await app.press("插件管理");
  await app.press("配置文本转语音");
  await app.waitFor("Alloy");
  await app.press("label:音色（必填）");
  await app.press("Cedar");
  await app.clear("label:音频保留天数");
  await app.type("label:音频保留天数", "14");
  await app.press("保存插件配置");
  await app.waitFor("插件配置已保存。");
  expect(submitted).toEqual({
    config: { server_url: "https://speech.example.test", model: "tts-1", voice: "cedar", audio_retention_days: 14 },
    config_revision: "fixture",
  });
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
  await app.waitFor("role:button[Accounts]");
  await app.press("role:button[Accounts]");
  await app.press("Plugins");
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
  expect(app.shows("插件管理")).toBe(false);
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
  await app.press("label:个人菜单");
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
  await app.press("label:个人菜单");
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
      [`POST ${endpoints}/proxies/test`]: ({ body }) => {
        expect(JSON.parse(body ?? "{}")).toEqual({
          proxy_url: proxyProfile.url, username: "fixture-user", password: "fixture-secret",
        });
        expect(profile).toBe(undefined);
        return { body: { status: 200, latency_ms: 7 } };
      },
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
  await app.press("测试连接");
  await app.waitFor("代理连接成功。HTTP 200，耗时 7 毫秒。");
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
        expect(input.inline_proxy).toBe(proxyId === null ? "keep" : "clear");
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
  expect(app.shows("label:HTTP 代理地址")).toBe(false);
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
  await app.press("直连");
  await app.press("保存账号");
  await app.waitFor("Operations");
  expect(proxyId).toBe(null);
});

const lazycat = {
  ...channel,
  id: "lazycat",
  display_name: "LazyCat",
  can_manage: true,
  config_schema: {
    properties: { user_id: { type: "string" }, device_id: { type: "string" } },
    required: ["device_id", "user_id"],
  },
};
const discovered = {
  user_id: "box-owner",
  max_selection: 16,
  devices: [
    { device_id: "mobile", name: "随身手机", online: true },
    { device_id: "laptop", name: "书房电脑", online: false },
  ],
};
const lazycatAccount = {
  id: "cat-a1",
  name: "个人设备",
  channel: "lazycat",
  enabled: true,
};

test("chooses discovered LazyCat devices on creation and preserves or replaces the saved destination", async () => {
  let saved: typeof lazycatAccount | undefined;
  let discoveries = 0;
  const updates: Record<string, unknown>[] = [];
  const app = await open("./App.tsx", {
    storage: chinesePreferences,
    platform: "linux",
    width: 1120,
    height: 1080,
    network: {
      ...baseNetwork(),
      [`${endpoints}/channels`]: { body: page([lazycat]) },
      [`${endpoints}/channels/lazycat/devices`]: () => {
        discoveries++;
        if (discoveries === 1)
          return {
            status: 403,
            body: {
              code: "lazycat_identity_required",
              message: "needs platform identity",
            },
          };
        if (discoveries === 2)
          return { body: { user_id: "box-owner", devices: [] } };
        return { body: discovered };
      },
      [`${endpoints}/channels/lazycat/devices?account_id=cat-a1`]: {
        body: { ...discovered, configured_device_ids: ["mobile", "laptop"] },
      },
      [`${endpoints}/accounts`]: () => ({ body: page(saved ? [saved] : []) }),
      [`POST ${endpoints}/accounts`]: ({ body }) => {
        const data = JSON.parse(body ?? "{}");
        expect(data.config).toEqual({
          user_id: "box-owner",
          device_ids: ["mobile", "laptop"],
        });
        saved = lazycatAccount;
        return { status: 201, body: saved };
      },
      [`PUT ${endpoints}/accounts/cat-a1`]: ({ body }) => {
        const data = JSON.parse(body ?? "{}");
        updates.push(data);
        saved = { ...lazycatAccount, name: data.name };
        return { body: saved };
      },
    },
  });
  await login(app);
  await app.press("role:button[账号]");
  await app.press("添加账号");
  await app.type("label:账号名称", "个人设备");
  await app.press("label:渠道");
  await app.press("懒猫微服通知");
  await app.waitFor("请从懒猫微服打开雁字，为当前登录的懒猫用户选择设备。");
  expect(app.enabled("保存账号")).toBe(false);
  expect(app.shows("使用 JSON 编辑配置")).toBe(false);
  await app.press("刷新设备");
  await app.waitFor("当前懒猫用户还没有已注册的设备。");
  await app.press("刷新设备");
  await app.waitFor("正在查找设备…", { state: "gone" });
  expect(app.enabled("保存账号")).toBe(false);
  await app.press("随身手机 · 在线");
  await app.press("书房电脑 · 离线");
  await app.press("保存账号");
  await app.waitFor("个人设备");
  await app.press("查看");
  await app.clear("label:账号名称");
  await app.type("label:账号名称", "办公提醒");
  await app.press("保存账号");
  await app.waitFor("办公提醒");
  expect("config" in updates[0]).toBe(false);
  expect(discoveries).toBe(3);
  await app.press("查看");
  await app.press("更换接收设备");
  await app.waitFor("正在查找设备…", { state: "gone" });
  await app.waitFor("已选 2 台 · 最多 16 台");
  await app.press("随身手机 · 在线");
  await app.press("保存账号");
  await app.waitFor("办公提醒");
  expect(updates[1].config).toEqual({
    user_id: "box-owner",
    device_id: "laptop",
  });
});

test("uses a LazyCat device picker for a subscription recipient override", async () => {
  let subscription: Record<string, unknown> | undefined;
  let owner = "box-owner";
  const app = await open("./App.tsx", {
    platform: "linux",
    storage: chinesePreferences,
    width: 1120,
    height: 1080,
    network: {
      ...baseNetwork(),
      [`${endpoints}/accounts`]: { body: page([lazycatAccount]) },
      [`${endpoints}/channels/lazycat/devices`]: () => ({
        body: { ...discovered, user_id: owner },
      }),
      [`${endpoints}/topics/ops/subscriptions`]: () => ({
        body: page(subscription ? [{ id: "sub1", ...subscription }] : []),
      }),
      [`POST ${endpoints}/topics/ops/subscriptions`]: ({ body }) => {
        subscription = JSON.parse(body ?? "{}");
        return { status: 201, body: { id: "sub1", ...subscription } };
      },
    },
  });
  await login(app);
  await app.press("role:button[主题]");
  await app.waitFor("ops");
  await app.press("查看");
  await app.press("添加订阅");
  await app.press("label:专属账号");
  await app.press("个人设备");
  await app.waitFor("使用账号的接收设备");
  expect(app.shows("label:接收目标（可选 JSON）")).toBe(false);
  await app.press("书房电脑 · 离线");
  owner = "other-owner";
  await app.press("刷新设备");
  await app.waitFor("所选设备已不在当前列表，请重新选择接收目标。");
  expect(app.enabled("保存订阅")).toBe(false);
  await app.press("书房电脑 · 离线");
  await app.type("label:主题密码", "fixture");
  await app.press("保存订阅");
  await app.waitFor("退订");
  expect(subscription?.target).toEqual({
    user_id: "other-owner",
    device_id: "laptop",
  });
});

test("account configuration JSON rejects inline proxies and replacement retains the previous connection", async () => {
  let update: Record<string, unknown> | undefined;
  const account = { id: "a1", name: "旧配置", channel: "ntfy", enabled: true };
  const app = await open("./App.tsx", {
    platform: "linux",
    storage: chinesePreferences,
    width: 1120,
    height: 1080,
    network: {
      ...baseNetwork(),
      [`${endpoints}/accounts`]: { body: page([account]) },
      [`${endpoints}/channels`]: {
        body: page([
          {
            ...channel,
            can_manage: true,
            config_schema: {
              properties: {
                topic: { type: "string" },
                proxy: { type: "string" },
              },
            },
          },
        ]),
      },
      [`${endpoints}/proxies`]: { body: page([proxyProfile]) },
      [`PUT ${endpoints}/accounts/a1`]: ({ body }) => {
        update = JSON.parse(body ?? "{}");
        return { body: account };
      },
    },
  });
  await login(app);
  await app.press("role:button[账号]");
  await app.waitFor("旧配置");
  await app.press("查看");
  await app.waitFor("保留当前连接");
  await app.press("替换已保存的配置");
  expect(app.shows("label:HTTP 代理地址")).toBe(false);
  await app.press("使用 JSON 编辑配置");
  await app.type(
    "label:渠道配置（JSON）",
    JSON.stringify({ topic: "alerts", proxy: "https://proxy.example.test" }),
  );
  await app.press("保存账号");
  await app.waitFor("请在出站代理中选择已保存的代理配置。");
  expect(update).toBe(undefined);
  await app.clear("label:渠道配置（JSON）");
  await app.type("label:渠道配置（JSON）", JSON.stringify({ topic: "alerts" }));
  await app.press("保存账号");
  await app.waitFor("旧配置");
  expect(update?.inline_proxy).toBe("keep");
  expect(update?.proxy_id).toBe(undefined);
  expect(update?.config).toEqual({ topic: "alerts" });
});

test("creates a channel account with a saved proxy profile", async () => {
  let created: Record<string, unknown> | undefined;
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
                proxy: { type: "string" },
              },
            },
          },
        ]),
      },
      [`${endpoints}/proxies`]: { body: page([proxyProfile]) },
      [`POST ${endpoints}/accounts`]: ({ body }) => {
        created = JSON.parse(body ?? "{}");
        return { status: 201, body: { id: "new", enabled: true, ...created } };
      },
    },
  });
  await login(app);
  await app.press("role:button[账号]");
  await app.press("添加账号");
  await app.type("label:账号名称", "Via profile");
  await app.press("label:渠道");
  await app.press("ntfy");
  await app.waitFor("直连");
  expect(app.shows("保留当前连接")).toBe(false);
  expect(app.shows("label:HTTP 代理地址")).toBe(false);
  await app.press("label:出站代理");
  await app.press(proxyProfile.name);
  await app.type("label:主题", "alerts");
  await app.press("保存账号");
  await app.waitFor("渠道账号");
  expect(created?.proxy_id).toBe(proxyProfile.id);
  expect(created?.config).toEqual({ topic: "alerts" });
  expect(created?.inline_proxy).toBe(undefined);
});

test("applies SMTP presets and requires a fresh password when the server changes", async () => {
  let savedConfig: unknown;
  const app = await open("./App.tsx", {
    platform: "linux",
    storage: chinesePreferences,
    width: 1120,
    height: 1080,
    network: {
      ...baseNetwork(),
      [`${endpoints}/channels`]: { body: page([{
        ...channel,
        id: "email",
        display_name: "SMTP 邮件",
        can_manage: true,
        config_schema: {
          "x-anser-ui": { presets: [
            { id: "qq", label: { "zh-CN": "QQ 邮箱" }, values: { host: "smtp.qq.com", port: 465, encryption: "tls" } },
            { id: "icloud", label: { "zh-CN": "iCloud 邮件" }, values: {
              host: "smtp.mail.me.com", port: 587, encryption: "starttls", password: "ignored",
            } },
          ] },
          properties: {
            host: { type: "string" }, port: { type: "integer" },
            encryption: { type: "string", enum: ["tls", "starttls"] },
            password: { type: "string", writeOnly: true, "x-anser-ui": { label: { "zh-CN": "邮件授权码" } } },
            from_name: { type: "string", "x-anser-ui": { label: { "zh-CN": "发件人显示名称" } } },
          },
        },
      }]) },
      [`POST ${endpoints}/accounts`]: ({ body }) => {
        const payload = JSON.parse(body ?? "{}");
        savedConfig = payload.config;
        return { status: 201, body: { id: "mail", enabled: true, ...payload } };
      },
    },
  });
  await login(app);
  await app.press("role:button[账号]");
  await app.press("添加账号");
  await app.type("label:账号名称", "提醒邮件");
  await app.press("label:渠道");
  await app.press("SMTP 邮件");
  await app.press("label:连接预设");
  await app.press("QQ 邮箱");
  await app.type("label:邮件授权码", "previous-fixture");
  await app.press("label:连接预设");
  await app.press("iCloud 邮件");
  await app.type("label:发件人显示名称", "雁字提醒");
  await app.press("保存账号");
  await app.waitFor("渠道账号");
  expect(savedConfig).toEqual({
    host: "smtp.mail.me.com", port: 587, encryption: "starttls", from_name: "雁字提醒",
  });
});

test("opens a saved plugin form with settings filled and credentials empty", async () => {
  const account = {
    id: "smtp", channel: "email", name: "QQ 邮件", tags: [], weight: 1, priority: 0, enabled: true,
  };
  let saved: Record<string, unknown> | undefined;
  const app = await open("./App.tsx", {
    platform: "linux",
    storage: chinesePreferences,
    width: 1120,
    height: 1080,
    network: {
      ...baseNetwork(),
      [`${endpoints}/accounts`]: { body: page([account]) },
      [`${endpoints}/channels`]: { body: page([{
        ...channel, id: "email", display_name: "邮件", can_manage: true,
        config_schema: {
          "x-anser-ui": { account_editor: { fields: ["host", "from_name"] } },
          properties: {
            host: { type: "string" },
            password: { type: "string", writeOnly: true },
            from_name: { type: "string", "x-anser-ui": { label: { "zh-CN": "发件人显示名称" } } },
          },
          required: ["host", "password"],
        },
      }]) },
      [`GET ${endpoints}/accounts/smtp/config`]: { body: {
        config: { host: "smtp.qq.com" }, saved_credentials: ["password"], revision: "fixture-revision",
      } },
      [`PUT ${endpoints}/accounts/smtp`]: ({ body }) => {
        saved = JSON.parse(body ?? "{}");
        return { body: account };
      },
    },
  });
  await login(app);
  await app.press("role:button[账号]");
  await app.waitFor("QQ 邮件");
  await app.press("查看");
  await app.waitFor("label:发件人显示名称");
  expect(app.shows("替换渠道配置")).toBe(false);
  await app.type("label:发件人显示名称", "雁字提醒");
  await app.press("保存账号");
  await app.waitFor("渠道账号");
  expect(saved?.config).toEqual({ host: "smtp.qq.com", from_name: "雁字提醒" });
  expect(saved?.config_revision).toBe("fixture-revision");
});

test("creates and edits a Topic and saves workspace default routing", async () => {
  let saved = { ...topic, name: "house", description: "", protected: false };
  let defaultMode = "broadcast";
  const app = await open("./App.tsx", {
    platform: "linux",
    storage: chinesePreferences,
    width: 1120,
    height: 1080,
    network: {
      ...baseNetwork(),
      [`POST ${endpoints}/topics`]: ({ body }) => {
        const input = JSON.parse(body ?? "{}");
        expect(input.name).toBe("house");
        saved = { ...saved, ...input };
        return { status: 201, body: saved };
      },
      [`PUT ${endpoints}/topics/house`]: ({ body }) => {
        const input = JSON.parse(body ?? "{}");
        expect(input.description).toBe("Household alerts");
        saved = { ...saved, ...input };
        return { body: saved };
      },
      [`${endpoints}/topics/house/subscriptions`]: { body: page() },
      [`${endpoints}/default-route`]: {
        body: { mode: defaultMode, targets: [] },
      },
      [`PUT ${endpoints}/default-route`]: ({ body }) => {
        const input = JSON.parse(body ?? "{}");
        defaultMode = input.mode;
        return { body: input };
      },
    },
  });
  await login(app);
  await app.press("role:button[主题]");
  await app.press("创建主题");
  await app.type("label:主题名称", "house");
  await app.press("保存主题");
  await app.waitFor("编辑主题");
  await app.press("编辑主题");
  await app.type("label:描述", "Household alerts");
  await app.press("保存主题");
  await app.waitFor("Household alerts");
  await app.press("role:button[主题]");
  await app.press("默认路由");
  await app.waitFor("保存默认路由");
  await app.press("label:路由方式");
  await app.press("加权随机选择");
  await app.press("保存默认路由");
  await app.waitFor("创建主题");
  expect(defaultMode).toBe("weighted");
});

test("tests a saved channel account and replays a dead letter from delivery history", async () => {
  let tested = false;
  let replayed = false;
  const dead = {
    id: "old",
    message: { title: "Desk alert", body: "Please check", format: "text" },
    status: "dead",
    created_at: 1780000000000,
  };
  const account = {
    id: "desk",
    name: "Desk account",
    channel: "ntfy",
    enabled: true,
  };
  const app = await open("./App.tsx", {
    platform: "linux",
    storage: chinesePreferences,
    width: 1120,
    height: 1080,
    network: {
      ...baseNetwork(),
      [`${endpoints}/accounts`]: { body: page([account]) },
      [`POST ${endpoints}/accounts/desk/test`]: ({ body }) => {
        const input = JSON.parse(body ?? "{}");
        expect(input.body).toBe("Testing");
        tested = true;
        return { body: { status: "success" } };
      },
      [`${endpoints}/messages`]: { body: page([dead]) },
      [`${endpoints}/messages/old`]: { body: { ...dead, deliveries: [] } },
      [`POST ${endpoints}/messages/old/replay`]: ({ headers }) => {
        expect(
          Boolean(headers["idempotency-key"] ?? headers["Idempotency-Key"]),
        ).toBe(true);
        replayed = true;
        return { status: 202, body: { message_id: "new", status: "pending" } };
      },
      [`${endpoints}/messages/new`]: {
        body: {
          ...dead,
          id: "new",
          status: "success",
          deliveries: [],
          inbox_deliveries: 1,
        },
      },
    },
  });
  await login(app);
  await app.press("role:button[账号]");
  await app.waitFor("Desk account");
  await app.press("查看");
  await app.press("测试已保存的账号");
  await app.clear("label:测试正文");
  await app.type("label:测试正文", "Testing");
  await app.press("发送测试通知");
  await app.waitFor("渠道已接收测试通知。");
  await app.press("role:button[投递]");
  await app.waitFor("Desk alert");
  await app.press("查看");
  await app.waitFor("重放通知");
  app.onDialog(() => "重放通知");
  await app.press("重放通知");
  await app.waitFor("已送达 1 个收件箱");
  expect(tested).toBe(true);
  expect(replayed).toBe(true);
});

test("opens the native account menu and saves a nickname and avatar in its dialog", async () => {
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jNUkAAAAASUVORK5CYII=";
  const image = `data:image/png;base64,${png}`;
  let avatar = false;
  let saves = 0;
  const app = await open("./App.tsx", {
    platform: "linux",
    storage: chinesePreferences,
    width: 1120,
    height: 760,
    network: {
      ...baseNetwork(),
      [`${endpoints}/auth/profile`]: {
        body: { nickname: null, avatar: null },
      },
      [`PUT ${endpoints}/auth/profile`]: ({ body }) => {
        const value = JSON.parse(body ?? "{}");
        expect(value).toEqual(
          ++saves === 1
            ? { nickname: "值班同事", avatar: image }
            : { nickname: null, avatar: null },
        );
        return { body: value };
      },
    },
  });
  app.onPick((request) => {
    expect(request.kind).toBe("files");
    expect(request.filters[0].extensions).toEqual([
      "png",
      "jpg",
      "jpeg",
      "webp",
    ]);
    return avatar
      ? [
          {
            name: "avatar.png",
            type: "image/png",
            data: Uint8Array.from(atob(png), (value) => value.charCodeAt(0)),
          },
        ]
      : [
          {
            name: "avatar.svg",
            type: "image/svg+xml",
            data: new Uint8Array([60, 115, 118, 103, 62]),
          },
        ];
  });
  await login(app);
  await app.press("label:个人菜单");
  await app.press("个人资料");
  await app.waitFor("role:dialog[个人资料]");
  await app.type("label:昵称", " 值班同事 ");
  await app.press("选择头像");
  await app.waitFor("请选择 PNG、JPEG 或 WebP 图片。");
  avatar = true;
  await app.press("选择头像");
  await app.waitFor("移除头像");
  await app.press("保存资料");
  await app.waitFor("role:dialog[个人资料]", { state: "gone" });
  await app.waitFor("值班同事");

  await app.press("label:个人菜单");
  await app.press("个人资料");
  await app.clear("label:昵称");
  await app.press("移除头像");
  await app.press("保存资料");
  await app.waitFor("role:dialog[个人资料]", { state: "gone" });
  await app.waitFor("alice");
  expect(saves).toBe(2);
});

test("shows local and connected server versions in About", async () => {
  const app = await open("./App.tsx", {
    platform: "linux",
    storage: chinesePreferences,
    width: 1120,
    height: 850,
    network: {
      ...baseNetwork(),
      [`${endpoints}/info`]: { body: { version: "9.8.7" } },
    },
  });
  await app.press("偏好设置");
  await app.press("关于");
  await app.waitFor("客户端版本");
  expect(app.shows("服务端版本")).toBe(false);
  expect(app.texts().some((value) => /^\d+\.\d+\.\d+$/.test(value))).toBe(true);

  await login(app);
  await app.press("偏好设置");
  await app.press("关于");
  await app.waitFor("客户端版本");
  await app.waitFor("服务端版本");
  await app.waitFor("9.8.7");
});

test("hands only newly received, same-server voice notifications to playback", async () => {
  const audioPath = (character: string) => `/v1/speech/audio/${character.repeat(43)}.mp3`;
  const previous = { ...inboxItem, title: "Earlier speech", audio_path: audioPath("a") };
  const outside = { ...inboxItem, id: 2, title: "Outside speech", audio_path: "https://outside.test/audio.mp3" };
  const next = { ...inboxItem, id: 3, title: "New speech", audio_path: audioPath("b") };
  let delivered = false;
  const app = await open("./App.tsx", {
    platform: "linux",
    locale: "zh-CN",
    network: {
      ...baseNetwork(),
      [`${endpoints}/inbox`]: { body: page([previous], "1") },
      [`${endpoints}/inbox?*`]: () => {
        if (delivered) return { body: page([], "3") };
        delivered = true;
        return { body: page([outside, next], "3") };
      },
    },
  });
  await login(app);
  await app.waitFor("id:speech-playing");
  await app.waitFor("New speech");
  await app.press("role:button[停止播放]");
});
