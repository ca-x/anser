import assert from "node:assert/strict";
import { BarkClient } from "bark-push";
import { scSend } from "serverchan-sdk";

const origin = new URL(process.env.ANSER_SDK_TEST_ORIGIN);
const key = process.env.ANSER_SDK_TEST_KEY;
assert.equal(origin.hostname, "127.0.0.1");
assert.equal(origin.protocol, "http:");
assert.ok(key);
const authorization = `Bearer ${key}`;

const bark = new BarkClient({
  baseUrl: new URL("/v1/receive/bark", origin).href,
  deviceKey: "default",
  headers: { authorization },
});
const pushed = await bark.push({ body: "Bark SDK", title: "SDK fixture" });
assert.equal(pushed.code, 200);

// The official ServerChan SDK fixes its origin. Adapt its transport for this
// dedicated process. The SDK still serializes the request and parses the reply.
const localFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input);
  assert.equal(url.href, "https://sctapi.ftqq.com/sdk-checks.send");
  const headers = new Headers(init.headers);
  headers.set("authorization", authorization);
  return localFetch(new URL(`/v1/receive/serverchan${url.pathname}`, origin), {
    ...init, headers, redirect: "error", signal: AbortSignal.timeout(5000),
  });
};
try {
  const ack = await scSend("sdk-checks", "SDK fixture", "ServerChan SDK");
  assert.equal(ack.code, 0);
  assert.ok(ack.data.pushid);
} finally {
  globalThis.fetch = localFetch;
}
