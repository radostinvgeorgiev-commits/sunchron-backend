import assert from "node:assert/strict";
import test from "node:test";

// Item 3, fix 1b (28.11): on the connector a write is prepared from the
// person's words and runs after the owner's exact confirmation. Each step is
// prepared under the owner, the task under the conversation, and the
// confirmation must find both. None of these is a real key.
process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY = "test-openai-key";
process.env.GOOGLE_CLIENT_ID = "test-google-client";
process.env.GOOGLE_CLIENT_SECRET = "test-google-secret";
process.env.GOOGLE_REDIRECT_URI = "https://novarium.test/api/google/callback";

const { sendMcpAgentMessage } = await import("../src/services/mcpAgentConversationService.js");
const { GOOGLE_BASE_SCOPES, createSession } = await import("../src/services/googleDriveService.js");
const { safeMcpError } = await import("../src/services/mcpReadService.js");

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const owner = { id: "owner", login: "owner", displayName: "Радко", role: "owner", memoryOwnerId: "connector-owner" };
const identity = { role: "owner", displayName: "Радко" };
const HIS_WORDS = "ПРАТИ МЕЛ ДО МЕН ТЕСТ ТУК ПРИ ПОСТ ЗДРАВЕ";

function workspace() {
  return {
    state: {
      activeProjectId: "project-1",
      activeAgentId: "agent-1",
      projects: [{ id: "project-1", name: "Проба", objective: "", run: null }],
      agents: [{ id: "agent-1", name: "NovariumAI", role: "builder", model: "auto", purpose: "", engine: "novarium" }],
    },
  };
}

async function ownGoogle() {
  const claims = Buffer.from(
    JSON.stringify({ sub: "owner-sub", email: "radko@example.com", email_verified: true }),
  ).toString("base64url");
  return createSession(
    { access_token: "stand-in", expires_in: 3600, scope: GOOGLE_BASE_SCOPES.join(" "), id_token: `e30.${claims}.signature` },
    owner,
  );
}

function gmail(t, { sendStatus = 200 } = {}) {
  const sends = [];
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    if (String(url) === `${GMAIL}/messages/send`) {
      sends.push(JSON.parse(options.body || "{}"));
      if (sendStatus !== 200) {
        return Response.json(
          { error: { status: "PERMISSION_DENIED", message: "Request had insufficient authentication scopes." } },
          { status: sendStatus },
        );
      }
      return Response.json({ id: `sent-${sends.length}`, threadId: "thread-1" });
    }
    return Response.json({ error: "not in this test" }, { status: 500 });
  });
  return sends;
}

function dependencies(googleSessionId, sessionName) {
  return {
    loadWorkspace: async () => workspace(),
    listMemories: async () => [],
    listMessages: async () => [],
    askAi: async () => assert.fail("the tool's answer is the reply"),
    saveTurn: async () => {},
    createSessionId: () => sessionName,
    getGoogleSession: async () => googleSessionId,
    getGitHubSession: async () => null,
    auditTask: async () => {},
    // The reader's plan for his words (fix 1); the rest is the real path.
    readWords: async ({ message }) =>
      message === HIS_WORDS
        ? {
            type: "requests",
            requests: [
              {
                capability: "mail.send",
                action: "mail.send",
                message,
                input: { to: "", toSelf: true, subject: "Тест тук при пост", body: "Тест тук при пост, здраве." },
              },
            ],
          }
        : { type: "none" },
  };
}

const confirmationIn = (text) => text.match(/Потвърждавам NovariumAI задача: ([0-9a-f-]{36})/u)?.[1];

test("the connector sends the email it prepared from his words once he confirms it", async (t) => {
  const sends = gmail(t);
  const deps = dependencies(await ownGoogle(), "mcp-confirm-email");

  const prepared = await sendMcpAgentMessage({ ownerId: "primary-user", message: HIS_WORDS, identity }, deps);
  // The connector keeps the exact confirmation: nothing is sent yet.
  assert.equal(sends.length, 0);
  const id = confirmationIn(prepared.response);
  assert.ok(id, prepared.response);
  assert.match(prepared.response, /radko@example\.com/u);

  const confirmed = await sendMcpAgentMessage(
    { ownerId: "primary-user", sessionId: prepared.sessionId, message: `Потвърждавам NovariumAI задача: ${id}`, identity },
    deps,
  );
  assert.equal(sends.length, 1);
  const mime = Buffer.from(sends[0].raw, "base64url").toString("utf8");
  assert.match(mime, /^To: radko@example\.com$/mu);
  assert.match(confirmed.response, /изпълнена: 1 операции/u);
  assert.deepEqual(confirmed.capabilities, ["mail.send"]);
  assert.equal(confirmed.externalActionsExecuted, true);

  // One time only: the same confirmation sends nothing more.
  await assert.rejects(
    sendMcpAgentMessage(
      { ownerId: "primary-user", sessionId: prepared.sessionId, message: `Потвърждавам NovariumAI задача: ${id}`, identity },
      deps,
    ),
    (error) => error?.code === "CONFIRMATION_NOT_FOUND",
  );
  assert.equal(sends.length, 1);
});

test("the confirmation stays with its conversation: another one cannot use it", async (t) => {
  const sends = gmail(t);
  const googleSessionId = await ownGoogle();
  const prepared = await sendMcpAgentMessage(
    { ownerId: "primary-user", message: HIS_WORDS, identity },
    dependencies(googleSessionId, "mcp-confirm-first"),
  );
  const id = confirmationIn(prepared.response);
  await assert.rejects(
    sendMcpAgentMessage(
      { ownerId: "primary-user", message: `Потвърждавам NovariumAI задача: ${id}`, identity },
      dependencies(googleSessionId, "mcp-confirm-other"),
    ),
    (error) => error?.code === "SESSION_MISMATCH",
  );
  assert.equal(sends.length, 0);
});

test("a send Google refuses says so on the connector, not that the service is down", async (t) => {
  gmail(t, { sendStatus: 403 });
  const deps = dependencies(await ownGoogle(), "mcp-confirm-refused");
  const prepared = await sendMcpAgentMessage({ ownerId: "primary-user", message: HIS_WORDS, identity }, deps);
  const id = confirmationIn(prepared.response);
  let failure;
  try {
    await sendMcpAgentMessage(
      { ownerId: "primary-user", sessionId: prepared.sessionId, message: `Потвърждавам NovariumAI задача: ${id}`, identity },
      deps,
    );
  } catch (error) {
    failure = error;
  }
  assert.equal(failure?.code, "TASK_WRITE_FAILED");
  const shown = safeMcpError(failure);
  assert.equal(shown.data?.code, "TASK_WRITE_FAILED");
  assert.doesNotMatch(shown.message, /временно не може/u);
  assert.match(shown.message, /Нито една подготвена промяна не беше изпълнена/u);
  // Google's own reason, as the site says it.
  assert.match(shown.message, /Gmail няма дадено разрешение/u);
});
