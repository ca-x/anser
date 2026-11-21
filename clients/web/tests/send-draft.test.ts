import assert from "node:assert/strict";
import test from "node:test";
import { SendSession } from "../src/send-draft.ts";
import type { Receipt } from "../src/api.ts";

const receipt = { message_id: "fixture-message", status: "pending" };

test("a lost response can be retried with the same idempotency key, even after returning to compose", async () => {
  const session = new SendSession();
  const keys: string[] = [];
  session.edit({ message: { title: "Finish the backup", body: "", format: "text" } });
  await assert.rejects(session.submit("backup", async (key) => {
    keys.push(key);
    throw Error("lost response");
  }));
  assert.equal(session.snapshot().draft.message.title, "Finish the backup");
  assert.ok(session.snapshot().error);
  const accepted = await session.submit("backup", async (key) => { keys.push(key); return receipt; });
  assert.deepEqual(accepted, receipt);
  assert.equal(session.snapshot().draft.message.title, "");
  assert.equal(keys[1], keys[0]);
  await session.submit("backup", async (key) => { keys.push(key); return receipt; });
  assert.notEqual(keys[2], keys[0]);
});

test("a later edit survives completion and a concurrent submit issues no second request", async () => {
  const session = new SendSession();
  const { promise, resolve } = Promise.withResolvers<Receipt>();
  const pending = session.submit("first", () => promise);
  session.edit({ tags: "next" });
  assert.equal(await session.submit("next", () => { throw Error("unexpected request"); }), undefined);
  resolve(receipt);
  assert.equal(await pending, undefined);
  assert.equal(session.snapshot().draft.tags, "next");
  assert.deepEqual(session.snapshot().receipt, receipt);
  session.acknowledgeReceipt();
  assert.equal(session.snapshot().receipt, undefined);
  assert.equal(session.snapshot().busy, false);
});

test("editing a failed submission changes its retry key and a new session starts empty", async () => {
  const session = new SendSession();
  let first = "";
  session.edit({ topic: "personal" });
  await assert.rejects(session.submit("personal", async (key) => { first = key; throw Error("timeout"); }));
  session.edit({ topic: "work" });
  await session.submit("work", async (key) => {
    assert.equal(new SendSession().snapshot().draft.topic, "");
    assert.notEqual(key, first);
    return receipt;
  });
});

test("personal delivery sends the chosen username, reuses its request key and opens the message receipt", async (context) => {
  const { Api } = await import("../src/api.ts");
  const api = new Api("fixture-session");
  const message = { title: "", body: "A quick check", format: "text" } as const;
  context.mock.method(globalThis, "fetch", async (path: string, init: RequestInit) => {
    assert.equal(path, "/v1/inbox/send");
    assert.equal(new Headers(init.headers).get("Idempotency-Key"), "fixture-key");
    assert.deepEqual(JSON.parse(String(init.body)), { ...message, recipient: "home-user" });
    return Response.json({ id: 431, message_id: "personal-message" }, { status: 201 });
  });
  const channelDraft = { ...message, tags: ["private"], url: "https://example.test/private", attachments: [{ url: "https://example.test/file" }] };
  assert.deepEqual(await api.sendInbox("home-user", channelDraft, "fixture-key"), { message_id: "personal-message", status: "success" });
});
