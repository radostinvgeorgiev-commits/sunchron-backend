import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  confirmCopilotTask,
  extractCopilotTaskNumber,
  extractCopilotConfirmationId,
  formatCopilotBridgeStatus,
  formatCopilotTaskStatus,
  getCopilotBridgeStatus,
  getCopilotTaskStatus,
  isCopilotBridgeStatusRequest,
  prepareCopilotTask,
  startCopilotTask,
} from "../src/services/copilotTaskService.js";
import {
  createGitHubSession,
  resetGitHubSessionsForTests,
  setFirestoreGitHubSessionStoreForTests,
} from "../src/services/githubOAuthService.js";
import {
  resetConfirmationsForTests,
  setFirestoreConfirmationStoreForTests,
} from "../src/services/confirmationService.js";
import { executeCapability } from "../src/tools/capabilityEngine.js";
import { resetToolRegistryForTests } from "../src/tools/toolRegistry.js";

const REPOSITORY = "radostinvgeorgiev-commits/sunchron-backend";

function githubStoreDouble() {
  const records = new Map();
  return {
    async get(id) {
      return records.has(id) ? structuredClone(records.get(id)) : null;
    },
    async set(id, payload) {
      records.set(id, structuredClone(payload));
    },
    async delete(id) {
      records.delete(id);
    },
  };
}

function confirmationStoreDouble() {
  const records = new Map();
  return {
    async saveConfirmation(id, data) {
      records.set(id, structuredClone(data));
    },
    async getConfirmation(id) {
      const data = records.get(id);
      return data ? { id, data: structuredClone(data) } : null;
    },
    async deleteConfirmation(id) {
      records.delete(id);
    },
  };
}

function createTaskFingerprintForTest(prompt) {
  return createHash("sha256")
    .update(`${REPOSITORY}\u0000main\u0000${prompt}`)
    .digest("hex")
    .slice(0, 24);
}

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
    if (call === 2) {
      assert.match(request.query, /ExistingCopilotTasks/u);
      return new Response(
        JSON.stringify({
          data: { repository: { issues: { nodes: [] } } },
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
  setFirestoreGitHubSessionStoreForTests(githubStoreDouble());
  setFirestoreConfirmationStoreForTests(confirmationStoreDouble());
  resetConfirmationsForTests();
  resetToolRegistryForTests();
  process.env.COPILOT_AUTOMATION_ENABLED = "true";
  process.env.PERSISTENCE_BACKEND = "firestore";
  process.env.GOOGLE_CLOUD_PROJECT = "handy-boulevard-479120-q9";
  process.env.FIRESTORE_DATABASE_ID = "(default)";
  process.env.GITHUB_CLIENT_ID = "test-client";
  process.env.GITHUB_CLIENT_SECRET = "test-secret";
});

test.afterEach(() => {
  resetGitHubSessionsForTests();
  setFirestoreGitHubSessionStoreForTests(null);
  setFirestoreConfirmationStoreForTests(null);
  resetConfirmationsForTests();
  resetToolRegistryForTests();
  delete process.env.COPILOT_AUTOMATION_ENABLED;
  delete process.env.GITHUB_CLIENT_ID;
  delete process.env.GITHUB_CLIENT_SECRET;
  delete process.env.PERSISTENCE_BACKEND;
  delete process.env.GOOGLE_CLOUD_PROJECT;
  delete process.env.FIRESTORE_DATABASE_ID;
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

test("service blocks a direct Copilot start when automation is disabled", async () => {
  const session = await connectedSession();
  let externalCallStarted = false;
  delete process.env.COPILOT_AUTOMATION_ENABLED;

  try {
    await assert.rejects(
      () =>
        startCopilotTask({
          githubSessionId: session.id,
          prompt: "Промени бутона.",
          fetchImpl: async () => {
            externalCallStarted = true;
            throw new Error("не трябва да се извиква");
          },
        }),
      (error) => error.code === "COPILOT_AUTOMATION_DISABLED",
    );
    assert.equal(externalCallStarted, false);
  } finally {
    process.env.COPILOT_AUTOMATION_ENABLED = "true";
  }
});

test("bridge status reports disabled mode without a GitHub call", async () => {
  let externalCallStarted = false;
  delete process.env.COPILOT_AUTOMATION_ENABLED;

  try {
    const status = await getCopilotBridgeStatus({
      githubSessionId: "unused",
      fetchImpl: async () => {
        externalCallStarted = true;
        throw new Error("не трябва да се извиква");
      },
    });
    assert.equal(status.status, "disabled");
    assert.equal(status.reasonCode, "COPILOT_AUTOMATION_DISABLED");
    assert.equal(externalCallStarted, false);
    assert.match(formatCopilotBridgeStatus(status), /работим без Copilot/u);
  } finally {
    process.env.COPILOT_AUTOMATION_ENABLED = "true";
  }
});

test("recognizes a GitHub Write availability question without starting a task", () => {
  assert.equal(
    isCopilotBridgeStatusRequest(
      "Демек вече може да пише в хъба и да комитва?",
    ),
    true,
  );
  assert.equal(
    isCopilotBridgeStatusRequest("Промени цвета и създай Pull Request."),
    false,
  );
});

test("recognizes a concrete Copilot task status request", () => {
  assert.equal(
    extractCopilotTaskNumber("Провери статуса на GitHub задача #83."),
    83,
  );
  assert.equal(
    extractCopilotTaskNumber("Покажи последния GitHub commit."),
    null,
  );
});

test("checks the real Copilot bridge through the owner GitHub session", async () => {
  const session = await connectedSession();
  const status = await getCopilotBridgeStatus({
    githubSessionId: session.id,
    repository: REPOSITORY,
    fetchImpl: copilotGraphqlFetch(),
  });

  assert.equal(status.status, "ready");
  assert.equal(status.connected, true);
  assert.equal(status.copilotEnabled, true);
  assert.equal(status.createsBranch, true);
  assert.equal(status.createsCommits, true);
  assert.equal(status.createsPullRequest, true);
  assert.equal(status.mergesMainAutomatically, false);
  assert.match(formatCopilotBridgeStatus(status), /работи/u);
  assert.match(formatCopilotBridgeStatus(status), /Не слива автоматично/u);
});

test("reports a missing GitHub owner session without claiming the bridge works", async () => {
  const status = await getCopilotBridgeStatus({
    githubSessionId: "",
    repository: REPOSITORY,
  });

  assert.equal(status.status, "not-connected");
  assert.equal(status.copilotEnabled, false);
  assert.match(formatCopilotBridgeStatus(status), /не е свързана/u);
  assert.doesNotMatch(
    formatCopilotBridgeStatus(status),
    /моста реално: работи/u,
  );
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
  assert.equal(result.deduplicated, false);
});

test("blocks a Copilot task from using any base other than main", async () => {
  const session = await connectedSession();
  await assert.rejects(
    () =>
      startCopilotTask({
        githubSessionId: session.id,
        prompt: "Промени цвета на бутона Памет.",
        repository: REPOSITORY,
        baseRef: "release",
        fetchImpl: async () => {
          throw new Error("GitHub must not be called");
        },
      }),
    (error) => error.code === "BASE_REF_NOT_ALLOWED",
  );
});

test("does not create a duplicate open Copilot task", async () => {
  const session = await connectedSession();
  let call = 0;
  const result = await startCopilotTask({
    githubSessionId: session.id,
    prompt: "Промени цвета на бутона Памет.",
    repository: REPOSITORY,
    fetchImpl: async (_url, options) => {
      call += 1;
      const request = JSON.parse(options.body);
      if (call === 1) {
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
      assert.match(request.query, /ExistingCopilotTasks/u);
      return new Response(
        JSON.stringify({
          data: {
            repository: {
              issues: {
                nodes: [
                  {
                    number: 81,
                    title: "Промени цвета",
                    url: "https://github.com/example/repo/issues/81",
                    body: `Задача\n<!-- synchron-copilot-task:${createTaskFingerprintForTest("Промени цвета на бутона Памет.")} -->`,
                    assignees: {
                      nodes: [{ login: "copilot-swe-agent" }],
                    },
                  },
                ],
              },
            },
          },
        }),
        { status: 200 },
      );
    },
  });
  assert.equal(call, 2);
  assert.equal(result.issueNumber, 81);
  assert.equal(result.deduplicated, true);
});

test("refuses to claim Copilot assignment when GitHub did not confirm it", async () => {
  const session = await connectedSession();
  const fetchImpl = copilotGraphqlFetch();
  await assert.rejects(
    () =>
      startCopilotTask({
        githubSessionId: session.id,
        prompt: "Промени цвета на бутона Памет.",
        repository: REPOSITORY,
        fetchImpl: async (url, options) => {
          const response = await fetchImpl(url, options);
          const payload = await response.json();
          if (payload.data?.createIssue?.issue) {
            payload.data.createIssue.issue.assignees.nodes = [];
          }
          return new Response(JSON.stringify(payload), {
            status: response.status,
          });
        },
      }),
    (error) => error.code === "COPILOT_ASSIGNMENT_UNCONFIRMED",
  );
});

test("tracks a Copilot issue through a green production status", async () => {
  const session = await connectedSession();
  const result = await getCopilotTaskStatus({
    githubSessionId: session.id,
    issueNumber: 83,
    repository: REPOSITORY,
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      assert.match(request.query, /CopilotTaskStatus/u);
      assert.match(request.query, /issueOrPullRequest/u);
      return new Response(
        JSON.stringify({
          data: {
            repository: {
              issueOrPullRequest: {
                __typename: "Issue",
                number: 83,
                title: "Проследи Copilot",
                url: "https://github.com/example/repo/issues/83",
                state: "CLOSED",
                assignees: { nodes: [{ login: "copilot-swe-agent" }] },
                closedByPullRequestsReferences: {
                  nodes: [
                    {
                      number: 146,
                      title: "Проследи Copilot",
                      url: "https://github.com/example/repo/pull/146",
                      state: "MERGED",
                      isDraft: false,
                      merged: true,
                      mergedAt: "2026-07-31T16:00:00Z",
                      baseRefName: "main",
                      headRefName: "copilot/task-status",
                      headRefOid: "abc123",
                      statusCheckRollup: {
                        state: "SUCCESS",
                        contexts: { nodes: [] },
                      },
                      mergeCommit: {
                        oid: "merge123",
                        statusCheckRollup: {
                          state: "SUCCESS",
                          contexts: {
                            nodes: [
                              {
                                __typename: "StatusContext",
                                context: "synchron/production-smoke",
                                state: "SUCCESS",
                                targetUrl: "https://github.com/example/run/1",
                              },
                            ],
                          },
                        },
                      },
                    },
                  ],
                },
                timelineItems: {
                  nodes: [],
                },
              },
            },
          },
        }),
        { status: 200 },
      );
    },
  });
  assert.equal(result.status, "real-tested");
  assert.equal(result.pullRequest.mergeSha, "merge123");
  assert.match(formatCopilotTaskStatus(result), /реално проверено/u);
  assert.match(formatCopilotTaskStatus(result), /pull\/146/u);
});

test("tracks a direct Pull Request number through production status", async () => {
  const session = await connectedSession();
  const result = await getCopilotTaskStatus({
    githubSessionId: session.id,
    issueNumber: 302,
    repository: REPOSITORY,
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      assert.match(
        request.query,
        /issueOrPullRequest\(number: \$issueNumber\)/u,
      );
      return new Response(
        JSON.stringify({
          data: {
            repository: {
              issueOrPullRequest: {
                __typename: "PullRequest",
                number: 302,
                title: "Подобри GitHub status",
                url: "https://github.com/example/repo/pull/302",
                state: "MERGED",
                isDraft: false,
                merged: true,
                mergedAt: "2026-08-09T01:00:00Z",
                baseRefName: "main",
                headRefName: "codex/github-status",
                headRefOid: "head302",
                statusCheckRollup: {
                  state: "SUCCESS",
                  contexts: { nodes: [] },
                },
                mergeCommit: {
                  oid: "merge302",
                  statusCheckRollup: {
                    state: "SUCCESS",
                    contexts: {
                      nodes: [
                        {
                          __typename: "StatusContext",
                          context: "synchron/production-smoke",
                          state: "SUCCESS",
                          targetUrl: "https://github.com/example/run/302",
                        },
                      ],
                    },
                  },
                },
              },
            },
          },
        }),
        { status: 200 },
      );
    },
  });

  assert.equal(result.resourceType, "pull-request");
  assert.equal(result.issue.number, 302);
  assert.equal(result.pullRequest.number, 302);
  assert.equal(result.pullRequest.mergeSha, "merge302");
  assert.equal(result.status, "real-tested");
  assert.match(formatCopilotTaskStatus(result), /GitHub Pull Request #302/u);
  assert.doesNotMatch(
    formatCopilotTaskStatus(result),
    /Pull Request: #302/u,
  );
});

test("does not prepare a Copilot confirmation without an exact task", async () => {
  const session = await connectedSession();

  await assert.rejects(
    () =>
      prepareCopilotTask({
        sessionId: "chat-session",
        githubSessionId: session.id,
        prompt: "   ",
      }),
    (error) => error.code === "MISSING_COPILOT_PROMPT",
  );
});

test("Copilot adapter is not called when the audited write guard blocks", async () => {
  const session = await connectedSession();
  const prepared = await prepareCopilotTask({
    sessionId: "chat-session",
    githubSessionId: session.id,
    prompt: "Промени цвета на бутона Памет.",
  });
  let githubCalls = 0;

  await assert.rejects(
    () =>
      confirmCopilotTask({
        confirmationId: prepared.confirmationId,
        sessionId: "chat-session",
        githubSessionId: session.id,
        fetchImpl: async () => {
          githubCalls += 1;
          throw new Error("must not call GitHub");
        },
        executeWrite: async () => {
          const error = new Error("audit unavailable");
          error.code = "AUDIT_UNAVAILABLE";
          throw error;
        },
      }),
    (error) => error.code === "AUDIT_UNAVAILABLE",
  );
  assert.equal(githubCalls, 0);
});
