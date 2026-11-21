import assert from "node:assert/strict";
import test from "node:test";
import { readPairing } from "../src/pairing.ts";

const now = 1000;
const code = "x".repeat(43);
function reply(server: string, expires = now + 100) {
  const url = new URL("anser://connect");
  url.searchParams.set("server", server);
  url.searchParams.set("code", code);
  return { url: url.toString(), expires_at: expires };
}

test("the card shows the origin signed by the server and discards an expired secret", () => {
  const valid = reply("https://relay.example:8443/");
  assert.deepEqual(readPairing(valid, now), { status: "ready", link: valid.url, origin: "https://relay.example:8443", expires: now + 100 });
  assert.deepEqual(readPairing(valid, now + 100), { status: "expired" });
});

test("a link the native app cannot import never reaches the QR or clipboard", () => {
  for (const server of ["http://localhost", "https://relay.example/admin", "https://u@relay.example/"]) {
    assert.equal(readPairing(reply(server), now).status, "error");
  }
  const valid = reply("https://relay.example/");
  for (const url of [valid.url + "&code=again", valid.url.replace(code, "short"), valid.url.replace("anser:", "https:")]) {
    assert.equal(readPairing({ ...valid, url }, now).status, "error");
  }
});
