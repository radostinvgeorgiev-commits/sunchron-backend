import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { readFile } from "node:fs/promises";

import {
  ACCOUNT_DELETE_PHRASE,
  deleteAccount,
  exportAccountData,
} from "../src/services/accountDataService.js";
import { createAccountRouter } from "../src/routes/accountRouter.js";

const member = {
  id: "uid-1",
  email: "member@example.test",
  role: "member",
  authProvider: "identity-platform",
  memoryOwnerId: "owner-1",
};

test("export contains the member's own data and no system records", async () => {
  const data = await exportAccountData(member, {
    listMemories: async ({ ownerId }) => {
      assert.equal(ownerId, "owner-1");
      return [
        { id: "canonical-project-definition", fact: "AI CORE е…", source: "system-canonical" },
        { id: "m1", fact: "Обичам кафе.", scope: "personal" },
      ];
    },
    listMessages: async () => [
      { sessionId: "s1", role: "assistant", content: "Здрасти", createdAt: "2026-11-25T10:00:01Z" },
      { sessionId: "s1", role: "user", content: "Здравей", createdAt: "2026-11-25T10:00:00Z" },
    ],
    loadWorkspace: async () => ({ state: { projects: [] } }),
    listSuggestions: async () => [{ id: "x", fact: "f" }],
    listGrants: async ({ subject }) => {
      assert.equal(subject, "uid-1");
      return [{ clientId: "synchron-claude", issuedAt: "2026-11-24", refreshTokenHash: "secret" }];
    },
    usage: async () => ({ plan: "free", remaining: 30, expiresAt: 1 }),
    now: () => new Date("2026-11-25T12:00:00Z"),
  });
  assert.deepEqual(data.memories.map((item) => item.id), ["m1"]);
  assert.deepEqual(data.conversations[0].messages.map((item) => item.role), ["user", "assistant"]);
  assert.equal(data.account.email, "member@example.test");
  assert.doesNotMatch(JSON.stringify(data), /secret/u);
  await assert.rejects(exportAccountData({ ...member, role: "owner" }), {
    code: "OWNER_ACCOUNT_PROTECTED",
  });
});

function deletionDeps(calls, { signIn } = {}) {
  return {
    authClient: () => ({
      auth: {
        signInWithPassword:
          signIn ||
          (async (input) => {
            calls.push(["signIn", input]);
            return { data: { user: { id: "uid-1" }, session: { access_token: "fresh" } }, error: null };
          }),
        deleteAccount: async (token) => (calls.push(["deleteAccount", token]), { data: {}, error: null }),
      },
    }),
    revokeGrants: async (input) => calls.push(["revoke", input]),
    listSuggestions: async () => [{ id: "s1" }],
    dismissSuggestion: async (input) => calls.push(["dismiss", input]),
    clearMemories: async (scope, ownerId) => (calls.push(["memories", scope, ownerId]), 3),
    deleteConversations: async (ownerId) => (calls.push(["conversations", ownerId]), 5),
    deleteWorkspace: async (ownerId) => calls.push(["workspace", ownerId]),
    forgetAvatarLink: async (ownerId) => calls.push(["avatar-link", ownerId]),
    clearTodos: async (ownerId) => calls.push(["todos", ownerId]),
    clearAddons: async (ownerId) => calls.push(["addons", ownerId]),
    forgetAvatarProfile: async (ownerId) => calls.push(["avatar-profile", ownerId]),
    audit: async (event) => calls.push(["audit", event.action]),
  };
}

test("deletion requires the phrase and a fresh password check, then removes everything", async () => {
  const calls = [];
  await assert.rejects(
    deleteAccount(member, { password: "p", confirm: "да" }, deletionDeps(calls)),
    { code: "ACCOUNT_DELETE_NOT_CONFIRMED" },
  );
  await assert.rejects(
    deleteAccount(member, { confirm: ACCOUNT_DELETE_PHRASE }, deletionDeps(calls)),
    { code: "ACCOUNT_DELETE_PASSWORD_REQUIRED" },
  );
  await assert.rejects(
    deleteAccount(
      member,
      { password: "wrong", confirm: ACCOUNT_DELETE_PHRASE },
      deletionDeps(calls, { signIn: async () => ({ data: null, error: new Error("bad") }) }),
    ),
    { code: "ACCOUNT_DELETE_REAUTH_FAILED" },
  );
  assert.equal(calls.length, 0);

  const result = await deleteAccount(
    member,
    { password: "right", confirm: ACCOUNT_DELETE_PHRASE },
    deletionDeps(calls),
  );
  assert.deepEqual(result, { deleted: true, memories: 3, conversations: 5 });
  assert.deepEqual(calls, [
    ["signIn", { email: "member@example.test", password: "right" }],
    ["revoke", { subject: "uid-1" }],
    ["dismiss", { ownerId: "owner-1", id: "s1" }],
    ["memories", undefined, "owner-1"],
    ["conversations", "owner-1"],
    ["workspace", "owner-1"],
    ["avatar-link", "owner-1"],
    ["todos", "owner-1"],
    ["addons", "owner-1"],
    ["avatar-profile", "owner-1"],
    ["deleteAccount", "fresh"],
    ["audit", "account.delete"],
  ]);
  await assert.rejects(
    deleteAccount({ ...member, role: "owner" }, { password: "x", confirm: ACCOUNT_DELETE_PHRASE }, deletionDeps([])),
    { code: "OWNER_ACCOUNT_PROTECTED" },
  );
});

test("a password for a different account cannot delete this one", async () => {
  await assert.rejects(
    deleteAccount(
      member,
      { password: "p", confirm: ACCOUNT_DELETE_PHRASE },
      deletionDeps([], {
        signIn: async () => ({ data: { user: { id: "someone-else" }, session: { access_token: "t" } }, error: null }),
      }),
    ),
    { code: "ACCOUNT_DELETE_REAUTH_FAILED" },
  );
});

test("account routes download a file and clear the session after deletion", async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.owner = member;
    next();
  });
  app.use(
    "/api/account",
    createAccountRouter({
      exportData: async () => ({ exportedAt: "2026-11-25T12:00:00.000Z", memories: [] }),
      removeAccount: async (owner, input) => {
        assert.equal(owner.id, "uid-1");
        assert.deepEqual(input, { password: "p", confirm: "ИЗТРИЙ" });
        return { deleted: true };
      },
    }),
  );
  const exported = await request(app).get("/api/account/export").expect(200);
  assert.match(exported.headers["content-disposition"], /ai-core-data-2026-11-25\.json/u);
  assert.equal(exported.headers["cache-control"], "no-store");
  const deleted = await request(app)
    .post("/api/account/delete")
    .send({ password: "p", confirm: "ИЗТРИЙ" })
    .expect(200);
  assert.match(String(deleted.headers["set-cookie"]), /synchron_user_session=;/u);
});

test("legal pages are published and linked from registration", async () => {
  const [html, privacy, terms, server] = await Promise.all(
    ["public/index.html", "public/privacy.html", "public/terms.html", "server.js"].map((path) =>
      readFile(new URL(`../${path}`, import.meta.url), "utf8"),
    ),
  );
  assert.match(html, /href="\/terms"/u);
  assert.match(html, /href="\/privacy"/u);
  assert.match(html, /google-site-verification/u);
  assert.match(html, /id="myDataBtn"/u);
  assert.match(privacy, /СИНХРОН Х ЕООД/u);
  assert.match(privacy, /Комисията за защита на личните данни/u);
  assert.match(privacy, /Limited Use/u);
  assert.match(privacy, /api-services-user-data-policy/u);
  assert.match(terms, /чл\. 57, т\. 13/u);
  assert.match(server, /app\.get\("\/privacy"/u);
  assert.match(server, /app\.get\("\/terms"/u);
});
