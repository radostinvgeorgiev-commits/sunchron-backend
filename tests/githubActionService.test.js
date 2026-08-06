import assert from "node:assert/strict";
import test from "node:test";

import {
  confirmGitHubChange,
  GITHUB_CONFIRMED_ACTIONS,
  GitHubActionError,
  prepareGitHubChange,
} from "../src/services/githubActionService.js";

const githubSession = Object.freeze({
  login: "radostinvgeorgiev-commits",
  accessToken: "private-session-token",
});

test("prepares a bounded GitHub branch without executing it or persisting the token", async () => {
  let confirmation;
  let executed = false;
  const prepared = await prepareGitHubChange(
    {
      ownerId: "primary-user",
      sessionId: "session-1",
      githubSession,
      operation: "create_branch",
      input: { branchName: "agent/safe-change" },
    },
    {
      createConfirmation: async (input) => {
        confirmation = {
          id: "confirmation-1",
          expiresAt: Date.now() + 60_000,
          ...input,
        };
        return confirmation;
      },
      execute: () => {
        executed = true;
      },
    },
  );

  assert.equal(executed, false);
  assert.equal(confirmation.action, GITHUB_CONFIRMED_ACTIONS.CREATE_BRANCH);
  assert.equal(confirmation.resource.branchName, "agent/safe-change");
  assert.equal(confirmation.resource.fromBranch, "main");
  assert.match(confirmation.resource.ownerFingerprint, /^[0-9a-f]{64}$/u);
  assert.doesNotMatch(
    JSON.stringify(confirmation),
    /primary-user|private-session-token/u,
  );
  assert.equal(prepared.confirmationId, "confirmation-1");
});

test("blocks protected branches, secrets and protected configuration before confirmation", async () => {
  const base = {
    ownerId: "primary-user",
    sessionId: "session-1",
    githubSession,
  };
  await assert.rejects(
    () =>
      prepareGitHubChange({
        ...base,
        operation: "create_branch",
        input: { branchName: "main" },
      }),
    (error) =>
      error instanceof GitHubActionError && error.code === "PROTECTED_BRANCH",
  );
  await assert.rejects(
    () =>
      prepareGitHubChange({
        ...base,
        operation: "create_file",
        input: {
          branch: "agent/safe-change",
          path: "src/config.js",
          content: "const token = 'sk-proj-abcdefghijklmnopqrstuvwxyz';",
        },
      }),
    (error) => error.code === "GITHUB_SECRET_BLOCKED",
  );
  await assert.rejects(
    () =>
      prepareGitHubChange({
        ...base,
        operation: "update_file",
        input: {
          branch: "agent/safe-change",
          path: ".github/workflows/deploy.yml",
          sha: "a".repeat(40),
          content: "name: deploy",
        },
      }),
    (error) => error.code === "GITHUB_PROTECTED_PATH",
  );
});

test("executes only the exact GitHub change after owner and login binding", async () => {
  let confirmation;
  await prepareGitHubChange(
    {
      ownerId: "primary-user",
      sessionId: "session-1",
      githubSession,
      operation: "create_file",
      input: {
        branch: "agent/safe-change",
        path: "docs/status.md",
        content: "Ready",
        message: "Add status",
      },
    },
    {
      createConfirmation: async (input) => {
        confirmation = { id: "confirmation-2", ...input };
        return confirmation;
      },
    },
  );
  const order = [];
  const result = await confirmGitHubChange(
    {
      ownerId: "primary-user",
      sessionId: "session-1",
      confirmationId: "confirmation-2",
      githubSession,
    },
    {
      validateConfirmation: async () => confirmation,
      consumeConfirmation: async () => order.push("consume"),
      executeWrite: async ({ execute, capability }) => {
        order.push(`audit:${capability}`);
        return execute();
      },
      adapters: {
        createFile: async (input) => {
          order.push("create-file");
          assert.equal(input.branch, "agent/safe-change");
          assert.equal(input.path, "docs/status.md");
          assert.equal(input.content, "Ready");
          assert.equal(input.accessToken, githubSession.accessToken);
          return { sha: "b".repeat(40) };
        },
      },
    },
  );

  assert.deepEqual(order, [
    "consume",
    `audit:${GITHUB_CONFIRMED_ACTIONS.CREATE_FILE}`,
    "create-file",
  ]);
  assert.equal(result.sha, "b".repeat(40));
});

test("rejects a confirmation when the GitHub identity changes before consumption", async () => {
  let confirmation;
  await prepareGitHubChange(
    {
      ownerId: "primary-user",
      sessionId: "session-1",
      githubSession,
      operation: "close_issue",
      input: { issueNumber: 42 },
    },
    {
      createConfirmation: async (input) => {
        confirmation = { id: "confirmation-3", ...input };
        return confirmation;
      },
    },
  );
  let consumed = false;
  await assert.rejects(
    () =>
      confirmGitHubChange(
        {
          ownerId: "primary-user",
          sessionId: "session-1",
          confirmationId: "confirmation-3",
          githubSession: {
            login: "radostinvgeorgiev-commits",
            accessToken: "different-token",
          },
        },
        {
          validateConfirmation: async () => ({
            ...confirmation,
            resource: {
              ...confirmation.resource,
              githubLoginFingerprint: "0".repeat(64),
            },
          }),
          consumeConfirmation: async () => {
            consumed = true;
          },
        },
      ),
    (error) => error.code === "GITHUB_LOGIN_MISMATCH",
  );
  assert.equal(consumed, false);
});
