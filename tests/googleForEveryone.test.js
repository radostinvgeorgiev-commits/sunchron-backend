import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  createSession,
  getLatestGoogleSessionId,
  resetGoogleSessionsForTests,
  sessionBelongsTo,
} from "../src/services/googleDriveService.js";

const owner = { memoryOwnerId: "owner:radko", role: "owner" };
const maria = { memoryOwnerId: "user:maria", role: "member" };
const ivan = { memoryOwnerId: "user:ivan", role: "member" };

test("each Google connection belongs only to the account that made it", async () => {
  resetGoogleSessionsForTests();
  const mine = await createSession({ access_token: "m", expires_in: 3600 }, maria);
  assert.equal(await sessionBelongsTo(mine, maria), true);
  assert.equal(await sessionBelongsTo(mine, ivan), false);
  assert.equal(await sessionBelongsTo(mine, owner), false);
  assert.equal(await sessionBelongsTo("", maria), false);
  assert.equal(await sessionBelongsTo(mine, null), false);
});

test("an older connection without an account belongs to the owner only", async () => {
  resetGoogleSessionsForTests();
  const legacy = await createSession({ access_token: "o", expires_in: 3600 });
  assert.equal(await sessionBelongsTo(legacy, owner), true);
  assert.equal(await sessionBelongsTo(legacy, maria), false);
});

test("owner tools never pick up a member's Google connection", async () => {
  resetGoogleSessionsForTests();
  const ownerSession = await createSession({ access_token: "o", expires_in: 3600 }, owner);
  await createSession({ access_token: "m", expires_in: 3600 }, maria);
  assert.equal(await getLatestGoogleSessionId(), ownerSession);
  resetGoogleSessionsForTests();
  await createSession({ access_token: "m", expires_in: 3600 }, maria);
  assert.equal(await getLatestGoogleSessionId(), null);
});

test("every signed-in account can connect Google; restore stays owner-only", () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
  const server = read("../server.js");
  const mount = server.slice(server.indexOf('"/api/google",'), server.indexOf("googleDriveRouter,\n);") );
  assert.match(mount, /requireOwnerSession/u);
  assert.doesNotMatch(mount, /requirePrimaryOwner/u);
  const router = read("../src/routes/googleDriveRouter.js");
  assert.match(router, /router\.get\("\/restore", ownerOnly/u);
  assert.match(router, /router\.post\("\/analyze", publicAiBudgetContext/u);
  // The new connection belongs to the signed-in account.
  assert.match(router, /finishGoogleConnection\(tokens, req\.owner,/u);
  assert.match(router, /sessionBelongsTo\(id, req\.owner\)/u);
  assert.match(read("../src/routes/chat.js"), /sessionBelongsTo\(cookieGoogleSession, req\.owner\)/u);
});
