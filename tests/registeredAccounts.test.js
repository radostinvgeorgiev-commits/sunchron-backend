import test from "node:test";
import assert from "node:assert/strict";

import { summarizeRegisteredAccounts } from "../src/services/registeredAccountsService.js";

const now = Date.UTC(2026, 10, 26, 20, 0);

test("counts every registered account by day from the sign-in provider, dates only", async () => {
  let body;
  const summary = await summarizeRegisteredAccounts({
    env: { IDENTITY_PLATFORM_PROJECT_ID: "p" },
    token: "t",
    now: () => now,
    fetchImpl: async (url, options) => {
      body = JSON.parse(options.body);
      assert.match(url, /projects\/p\/accounts:query$/u);
      return new Response(JSON.stringify({ userInfo: [
        { localId: "a", email: "a@x.bg", createdAt: String(Date.UTC(2026, 10, 20, 10)), lastLoginAt: String(now - 1000) },
        { localId: "b", email: "b@x.bg", createdAt: String(Date.UTC(2026, 10, 26, 9)), lastLoginAt: String(now - 10 * 86400000) },
        { localId: "c", createdAt: String(Date.UTC(2026, 10, 26, 12)) },
      ] }));
    },
  });
  assert.equal(body.returnUserInfo, true);
  assert.deepEqual(summary, {
    available: true,
    total: 3,
    signedInLast7Days: 1,
    byDay: { "2026-11-20": 1, "2026-11-26": 2 },
  });
  assert.doesNotMatch(JSON.stringify(summary), /x\.bg|"a"/u);
});

test("without the right to read accounts it says so plainly", async () => {
  const summary = await summarizeRegisteredAccounts({
    env: { IDENTITY_PLATFORM_PROJECT_ID: "p" },
    token: "t",
    fetchImpl: async () => new Response("{}", { status: 403 }),
  });
  assert.equal(summary.available, false);
  assert.match(summary.reason, /право/u);
});
