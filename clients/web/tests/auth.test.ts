import assert from "node:assert/strict";
import test from "node:test";
import { Api, ApiError, errorMessage } from "../src/api.ts";

test("verification errors preserve their code and do not invalidate the session", async (context) => {
  let code = "totp_required";
  context.mock.method(globalThis, "fetch", async () => Response.json({ code, message: "Fixture error" }, { status: 401 }));
  let signOuts = 0;
  const api = new Api("fixture-session", () => { signOuts++; });

  await assert.rejects(api.write("/auth/login", "POST", {}), (error) => error instanceof ApiError && error.code === code);
  code = "invalid_totp";
  await assert.rejects(api.write("/auth/login", "POST", {}), (error) =>
    error instanceof ApiError && error.code === code && errorMessage(error) === "验证码无效或已使用，请输入新代码。");
  assert.equal(signOuts, 0);

  code = "authentication_required";
  await assert.rejects(api.read("/auth/totp"), (error) => error instanceof ApiError && error.code === code);
  assert.equal(signOuts, 1);
});
