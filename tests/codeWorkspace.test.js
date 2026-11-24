import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { configureGitHubAppFixture, githubAppFetchFixture } from "./githubAppFixture.js";

configureGitHubAppFixture();
const repository = "radostinvgeorgiev-commits/sunchron-backend";
const sha = "a".repeat(40);
const newCommit = "c".repeat(40);
const original = "export const number = 1;\n";
const changed = "export const number = 2;\n";
const pkg = '{"type":"module"}';
Object.assign(process.env, {
  NODE_ENV: "test",
  PERSISTENCE_BACKEND: "firestore",
  GITHUB_REPOSITORY: repository,
  GITHUB_SESSION_ENCRYPTION_KEY: "g".repeat(48),
  OPENAI_API_KEY: "test-openai",
  GEMINI_API_KEY: "test-gemini",
  GROK_API_KEY: "test-grok",
  ANTHROPIC_API_KEY: "test-claude",
  CODEX_AGENT_ENABLED: "true",
  AI_CORE_COUNCIL_CODEX_MODEL: "gpt-5.3-codex",
});

const { default: app } = await import("../server.js");
const { createGitHubSession, setFirestoreGitHubSessionStoreForTests } =
  await import("../src/services/githubOAuthService.js");
const { setFirestoreConfirmationStoreForTests } =
  await import("../src/services/confirmationService.js");
const { setFirestoreAuditStoreForTests } =
  await import("../src/services/permissionService.js");

async function setup(
  t,
  proposal = changed,
  { unavailable = [], badPlanners = [] } = {},
) {
  const confirmations = new Map();
  const audits = [];
  const writes = [];
  const calls = [];
  let head = sha;
  setFirestoreGitHubSessionStoreForTests({ set: async () => {} });
  setFirestoreConfirmationStoreForTests({
    saveConfirmation: async (id, payload) => confirmations.set(id, payload),
    getConfirmation: async (id) =>
      confirmations.has(id) ? { data: confirmations.get(id) } : null,
    deleteConfirmation: async (id) => confirmations.delete(id),
  });
  setFirestoreAuditStoreForTests({
    saveAuditEntry: async (_, entry) => audits.push(entry),
  });
  async function ownerCookie() {
    const login = repository.split("/")[0];
    const session = await createGitHubSession(
      { access_token: "fake-owner-token" },
      githubAppFetchFixture({ login, token: "fake-owner-token" }),
    );
    return `synchron_github_session=${session.id}`;
  }
  const cookie = await ownerCookie();
  const secondCookie = await ownerCookie();
  const plan = JSON.stringify({
    title: "Update example",
    summary: "Make a change",
    commitMessage: "Update example",
    pullRequestBody: "Update example",
    changes: [{ path: "src/example.js", content: proposal, reason: "Example" }],
  });
  function engineReply(provider, planning, format) {
    calls.push({ provider, planning });
    if (unavailable.includes(provider))
      return new Response(null, { status: 503 });
    if (planning && badPlanners.includes(provider))
      return Response.json(format("Няма валиден JSON"));
    return Response.json(format(planning ? plan : `${provider} advice`));
  }
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.hostname === "api.openai.com") {
      const input = JSON.parse(options.body);
      const planning = Boolean(input.text?.format);
      if (planning)
        assert.match(input.input[0].content, /export const number = 1/u);
      return engineReply(
        input.model === "gpt-5.3-codex" ? "codex" : "openai",
        planning,
        (text) => ({ model: input.model, output_text: text }),
      );
    }
    if (parsed.hostname === "generativelanguage.googleapis.com") {
      const input = JSON.parse(options.body);
      return engineReply(
        "gemini",
        input.generationConfig?.responseMimeType === "application/json",
        (text) => ({ candidates: [{ content: { parts: [{ text }] } }] }),
      );
    }
    if (parsed.hostname === "api.x.ai") {
      const input = JSON.parse(options.body);
      return engineReply(
        "grok",
        input.response_format?.type === "json_object",
        (text) => ({ choices: [{ message: { content: text } }] }),
      );
    }
    if (parsed.hostname === "api.anthropic.com") {
      const input = JSON.parse(options.body);
      return engineReply(
        "claude",
        input.messages[0].content.includes("Върни само JSON"),
        (text) => ({ content: [{ type: "text", text }] }),
      );
    }
    assert.equal(parsed.hostname, "api.github.com");
    const path = parsed.pathname.slice(`/repos/${repository}`.length);
    if (options.method === "POST") {
      writes.push({ path, body: JSON.parse(options.body) });
      if (path === "/git/trees") return Response.json({ sha: "new-tree" });
      if (path === "/git/commits") return Response.json({ sha: newCommit });
      if (path === "/git/refs") return Response.json({});
      if (path === "/pulls")
        return Response.json({
          number: 12,
          html_url: `https://github.com/${repository}/pull/12`,
        });
    }
    if (path === "")
      return Response.json({ full_name: repository, default_branch: "main" });
    if (path === "/git/ref/heads/main")
      return Response.json({ object: { sha: head } });
    if (path === `/git/trees/${sha}`) {
      assert.equal(parsed.searchParams.get("recursive"), "1");
      return Response.json({
        tree: [
          {
            path: "package.json",
            type: "blob",
            mode: "100644",
            size: Buffer.byteLength(pkg),
          },
          {
            path: "src/example.js",
            type: "blob",
            mode: "100644",
            size: Buffer.byteLength(original),
          },
        ],
      });
    }
    if (path.startsWith("/contents/")) {
      assert.equal(parsed.searchParams.get("ref"), sha);
      const file = path.endsWith("package.json") ? pkg : original;
      return Response.json({
        type: "file",
        content: Buffer.from(file).toString("base64"),
      });
    }
    if (path === `/git/commits/${sha}`)
      return Response.json({ tree: { sha: "base-tree" } });
    if (path === `/commits/${newCommit}/check-runs`) {
      return Response.json({
        check_runs: [
          { name: "Node.js", status: "completed", conclusion: "success" },
        ],
      });
    }
    assert.fail(`Unexpected GitHub fixture route: ${path}`);
  });
  return {
    cookie,
    secondCookie,
    writes,
    calls,
    audits,
    confirmations,
    moveHead: () => {
      head = "b".repeat(40);
    },
  };
}

const prepare = (cookie) =>
  request(app)
    .post("/api/code-workspace/prepare")
    .set("Cookie", cookie)
    .send({ repository, message: "Update src/example.js." });

const confirm = (cookie, confirmationId) =>
  request(app)
    .post("/api/code-workspace/confirm")
    .set("Cookie", cookie)
    .send({ confirmationId });

test("an owner can review a pinned diff, approve the exact change once and see CI", async (t) => {
  const { cookie, secondCookie, writes, audits } = await setup(t);
  await request(app).get("/api/code-workspace/repository").expect(401);
  await request(app)
    .get("/api/code-workspace/repository")
    .set("Cookie", cookie)
    .expect(200, { repository, base: "main" });
  await request(app)
    .post("/api/code-workspace/prepare")
    .set("Cookie", cookie)
    .send({ repository: "another/project", message: "Change it." })
    .expect(400);

  const { body: draft } = await prepare(cookie).expect(200);
  assert.equal(draft.baseSha, sha);
  assert.deepEqual(
    draft.council.map(({ provider }) => provider),
    ["openai", "gemini", "grok", "claude", "codex"],
  );
  assert.equal(draft.executor.provider, "codex");
  assert.equal(draft.review[0].check.status, "passed");
  assert.match(
    draft.review[0].diff,
    /-export const number = 1;\n\+export const number = 2;/u,
  );
  assert.equal(writes.length, 0);
  await confirm(secondCookie, draft.confirmationId).expect(409);
  assert.equal(writes.length, 0);

  const { body: pr } = await confirm(cookie, draft.confirmationId).expect(200);
  assert.equal(pr.pullRequestNumber, 12);
  assert.equal(pr.commitSha, newCommit);
  assert.deepEqual(
    writes.map(({ path }) => path),
    ["/git/trees", "/git/commits", "/git/refs", "/pulls"],
  );
  assert.equal(writes[0].body.tree[0].content, changed);
  assert.deepEqual(writes[1].body.parents, [sha]);
  assert.match(writes[2].body.ref, /^refs\/heads\/ai-core\/task-/u);
  assert.deepEqual(
    audits.map(({ phase }) => phase),
    ["intent", "outcome"],
  );
  await confirm(cookie, draft.confirmationId).expect(409);
  assert.equal(writes.length, 4);
  await request(app)
    .get(`/api/code-workspace/checks/${newCommit}`)
    .set("Cookie", cookie)
    .expect(200, {
      checks: [{ name: "Node.js", status: "completed", conclusion: "success" }],
    });
});

test("failed syntax prevents approval and GitHub writes", async (t) => {
  const invalid = await setup(t, "export const = ;\n");
  const { body: failed } = await prepare(invalid.cookie).expect(200);
  assert.equal(failed.review[0].check.status, "failed");
  assert.equal(failed.confirmationId, undefined);
  assert.equal(invalid.confirmations.size, 0);
  assert.deepEqual(invalid.writes, []);
});

test("confirming a review whose base moved does not create a commit", async (t) => {
  const { cookie, writes, moveHead } = await setup(t);
  const { body: draft } = await prepare(cookie).expect(200);
  moveHead();
  const { body } = await confirm(cookie, draft.confirmationId).expect(409);
  assert.equal(body.code, "CODE_TASK_BASE_CHANGED");
  assert.deepEqual(writes, []);
});

test("Code uses a single responsive engine when the other four fail", async (t) => {
  const unavailable = ["openai", "gemini", "grok", "codex"];
  const { cookie, calls, writes } = await setup(t, changed, { unavailable });
  const { body: draft } = await prepare(cookie).expect(200);
  assert.deepEqual(
    draft.council.map(({ provider }) => provider),
    ["claude"],
  );
  assert.deepEqual(draft.unavailableProviders, unavailable);
  assert.equal(draft.executor.provider, "claude");
  assert.ok(draft.confirmationId);
  assert.deepEqual(
    calls.filter(({ planning }) => planning),
    [{ provider: "claude", planning: true }],
  );
  assert.deepEqual(writes, []);
});

test("Code tries another responsive engine if Codex fails to produce a plan", async (t) => {
  const { cookie, calls } = await setup(t, changed, {
    unavailable: ["openai", "grok"],
    badPlanners: ["codex"],
  });
  const { body: draft } = await prepare(cookie).expect(200);
  assert.equal(draft.executor.provider, "gemini");
  assert.deepEqual(
    calls.filter(({ planning }) => planning).map(({ provider }) => provider),
    ["codex", "gemini"],
  );
  assert.ok(draft.confirmationId);
});

test("Code keeps available advice when no engine can prepare a valid diff", async (t) => {
  const { cookie, confirmations, writes } = await setup(t, changed, {
    unavailable: ["openai", "grok", "claude", "codex"],
    badPlanners: ["gemini"],
  });
  const { body: draft } = await prepare(cookie).expect(200);
  assert.deepEqual(
    draft.advice.map(({ provider }) => provider),
    ["gemini"],
  );
  assert.equal(draft.confirmationId, undefined);
  assert.deepEqual(draft.review, []);
  assert.equal(confirmations.size, 0);
  assert.deepEqual(writes, []);
});
