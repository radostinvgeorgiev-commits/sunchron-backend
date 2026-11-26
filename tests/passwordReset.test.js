import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { requestPasswordReset } from "../src/services/userAuthService.js";

function clientWith(result) {
  const calls = [];
  return {
    calls,
    auth: {
      async sendPasswordResetEmail(email) {
        calls.push(email);
        return result;
      },
    },
  };
}

test("a reset email is requested for the normalized address", async () => {
  const client = clientWith({ data: { sent: true }, error: null });
  assert.deepEqual(
    await requestPasswordReset({ email: "  Ivo@Example.Test " }, { client }),
    { sent: true },
  );
  assert.deepEqual(client.calls, ["ivo@example.test"]);
});

test("an unknown address looks the same as a known one", async () => {
  const client = clientWith({
    data: null,
    error: Object.assign(new Error("Identity Platform request failed."), {
      code: "IDENTITY_PLATFORM_REQUEST_FAILED",
      upstreamCode: "EMAIL_NOT_FOUND",
      status: 400,
    }),
  });
  assert.deepEqual(await requestPasswordReset({ email: "x@example.test" }, { client }), {
    sent: true,
  });
});

test("invalid input, rate limits and outages are reported safely", async () => {
  await assert.rejects(
    requestPasswordReset({ email: "not-an-email" }, { client: clientWith({}) }),
  );
  await assert.rejects(
    requestPasswordReset(
      { email: "a@example.test" },
      { client: clientWith({ data: null, error: Object.assign(new Error("TOO_MANY_ATTEMPTS_TRY_LATER"), { status: 400 }) }) },
    ),
    { code: "AUTH_RATE_LIMITED", status: 429 },
  );
  await assert.rejects(
    requestPasswordReset(
      { email: "a@example.test" },
      { client: clientWith({ data: null, error: new Error("boom") }) },
    ),
    { code: "AUTH_PASSWORD_RESET_FAILED" },
  );
  await assert.rejects(
    requestPasswordReset({ email: "a@example.test" }, { client: { auth: {} } }),
    { code: "AUTH_PASSWORD_RESET_UNAVAILABLE" },
  );
});

test("the sign-in form offers password recovery", async () => {
  const [html, router] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../src/routes/userAuthRouter.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /id="forgotPasswordBtn"/u);
  assert.match(router, /router\.post\("\/password-reset"/u);
});
