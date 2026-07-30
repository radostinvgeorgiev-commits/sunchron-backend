import assert from "node:assert/strict";
import test from "node:test";

import {
  confirmCopilotTask,
  extractCopilotConfirmationId,
  prepareCopilotTask,
  startCopilotTask,
} from "../src/services/copilotTaskService.js";
import {
  createGitHubSession,
  resetGitHubSessionsForTests,
} from "../src/services/githubOAuthService.js";
import { resetConfirmationsForTests } from "../src/services/confirmationService.js";
import { executeCapability } from "../src/tools/capabilityEngine.js";
import { resetToolRegistryForTests } from "../src/tools/toolRegistry.js";

const REPOSITORY = "radostinvgeorgiev-commits/sunchron-backend";

async function connectedSession() {
  return createGitHubSession(
    { access_token: "ghu-user-token" },
    async () =>
      new Response(JSON.stringify({ login: "radostinvgeorgiev-commits" }), {
        status: 200,
      }),
  );
}

function copilotGraphqlFetch() {
  let call = 0;
  return async (_url, options) => {
    call += 1;
    const request = JSON.parse(options.body);
    assert.equal(options.headers.Authorization, "Bearer ghu-user-token");
    assert.match(
      options.headers["GraphQL-Features"],
      /issues_copilot_assignment_api_support/u,
    );
    if (call === 1) {
      assert.match(request.query, /suggestedActors/u);
      return new Response(
        JSON.stringify({
          data: {
            repository: {
              id: "R_repo",
              suggestedActors: {
                nodes: [{ id: "B_copilot", login: "copilot-swe-agent" }],
              },
            },
          },
        }),
        { status: 200 },
      );
    }
    assert.match(request.query, /createIssue/u);
    assert.equal(request.variables.baseRef, "main");
    assert.match(request.variables.body, /Промени цвета/u);
    return new Response(
      JSON.stringify({
        data: {
          createIssue: {
            issue: {
              number: 81,
              title: "Промени цвета",
              url: "https://github.com/example/repo/issues/81",
              assignees: {
                nodes: [{ login: "copilot-swe-agent" }],
              },
            },
          },
        },
      }),
      { status: 200 },
    );
  };
}

test.beforeEach(() => {
  resetGitHubSessionsForTests();
  resetConfirmationsForTests();
  resetToolRegistryForTests();
  process.env.GITHUB_CLIENT_ID = "test-client";
  process.env.GITHUB_CLIENT_SECRET = "test-secret";
});

test.afterEach(() => {
  resetGitHubSessionsForTests();
  resetConfirmationsForTests();
  resetToolRegistryForTests();
  delete process.env.GITHUB_CLIENT_ID;
  delete process.env.GITHUB_CLIENT_SECRET;
});

test("code.write prepares a Copilot confirmation through Capability Engine", async () => {
  const session = await connectedSession();
  const result = await executeCapability(
    "code.write",
    {
      sessionId: "chat-session",
      githubSessionId: session.id,
      message: "Промени цвета на бутона Памет.",
    },
    { prepareConfirmation: true },
  );
  assert.equal(result.tool.id, "github-write");
  assert.match(result.output, /Подготвих кодовата задача/u);
  assert.match(result.output, /Потвърждавам GitHub задача:/u);
});

test("starts a Copilot task through a GitHub user session", async () => {
  const session = await connectedSession();
  const result = await startCopilotTask({
    githubSessionId: session.id,
    prompt: "Промени цвета на бутона Памет.",
    repository: REPOSITORY,
    fetchImpl: copilotGraphqlFetch(),
  });
  assert.equal(result.issueNumber, 81);
  assert.equal(result.assignee, "copilot-swe-agent");
});

test("requires an exact one-time confirmation before starting Copilot", async () => {
  const session = await connectedSession();
  const prepared = await prepareCopilotTask({
    sessionId: "chat-session",
    githubSessionId: session.id,
    prompt: "Промени цвета на бутона Памет.",
  });
  assert.match(prepared.output, /Потвърждавам GitHub задача:/u);
  assert.equal(
    extractCopilotConfirmationId(
      `Потвърждавам GitHub задача: ${prepared.confirmationId}`,
    ),
    prepared.confirmationId,
  );

  const result = await confirmCopilotTask({
    confirmationId: prepared.confirmationId,
    sessionId: "chat-session",
    githubSessionId: session.id,
    fetchImpl: copilotGraphqlFetch(),
  });
  assert.equal(result.issueNumber, 81);

  await assert.rejects(
    () =>
      confirmCopilotTask({
        confirmationId: prepared.confirmationId,
        sessionId: "chat-session",
        githubSessionId: session.id,
        fetchImpl: copilotGraphqlFetch(),
      }),
    (error) => error.code === "CONFIRMATION_NOT_FOUND",
  );
});
