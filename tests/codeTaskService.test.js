import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  confirmCodeTask,
  extractCodeTaskConfirmationId,
  prepareCodeTask,
} from "../src/services/codeTaskService.js";

const ownerLogin = "radostinvgeorgiev-commits";
const githubSession = { login: ownerLogin, accessToken: "github-access" };
const vertexEnv = {
  VERTEX_AI_ENABLED: "true",
  VERTEX_AI_PROJECT_ID: "novarium-test-12345",
  VERTEX_AI_LOCATION: "us-central1",
  VERTEX_AI_MODEL: "gemini-2.5-flash",
};
const plan = {
  title: "Подобри интерфейса за аватари",
  summary: "Добавя по-ясен избор и визуално състояние за аватарите.",
  commitMessage: "Improve avatar selection UI",
  pullRequestBody: "NovariumAI multi-engine code task.",
  changes: [
    {
      path: "public/avatar-proof.js",
      content: "export const avatarProof = true;\n",
      reason: "Проверим малък UI модул.",
    },
  ],
};

function advisor(provider) {
  return async () => ({
    provider,
    model: `${provider}-test-model`,
    text: `${provider} предлага минимална промяна и тест.`,
  });
}

test("Vertex Gemini prepares a bounded code confirmation", async () => {
  let storedConfirmation;
  const executorCalls = [];
  const prepared = await prepareCodeTask({
    ownerId: "owner-1",
    sessionId: "session-1",
    githubSessionId: "github-session",
    message: "Подобри интерфейса за аватарите.",
    env: vertexEnv,
    createWorkspace: async () => ({
      root: "C:/nonexistent-novarium-code-task-test",
      workspace: "C:/nonexistent-novarium-code-task-test/source",
    }),
    createSnapshot: async () => ({ text: "public/app.js\n// source" }),
    advisorRequesters: {
      gemini: async (options) => {
        if (options.outputSchema) {
          executorCalls.push("gemini");
          return { model: "gemini-code-model", text: JSON.stringify(plan) };
        }
        return advisor("gemini")(options);
      },
    },
    resolveGitHubSession: async () => githubSession,
    createConfirmation: async (confirmation) => {
      storedConfirmation = confirmation;
      return {
        id: "11111111-1111-4111-8111-111111111111",
        expiresAt: Date.now() + 60_000,
      };
    },
  });

  assert.deepEqual(
    prepared.council.map(({ provider }) => provider),
    ["gemini"],
  );
  assert.equal(prepared.files[0].path, "public/avatar-proof.js");
  assert.equal(storedConfirmation.action, "github.write:code_task");
  assert.deepEqual(executorCalls, ["gemini"]);
  assert.match(prepared.output, /Още не е записано нищо/u);
  assert.match(prepared.output, /Водещ кодов изпълнител: Vertex Gemini \(gemini-code-model\)/u);
  assert.doesNotMatch(prepared.output, /Codex/u);
  assert.equal(
    extractCodeTaskConfirmationId(
      `Потвърждавам NovariumAI кодова задача: ${prepared.confirmationId}`,
    ),
    prepared.confirmationId,
  );
});

test("Vertex Gemini is used for both code advice and execution", async () => {
  const planCalls = [];
  const prepared = await prepareCodeTask({
    ownerId: "owner-1",
    sessionId: "session-1",
    githubSessionId: "github-session",
    message: "Добави проверим UI модул.",
    env: vertexEnv,
    createWorkspace: async () => ({
      root: "C:/nonexistent-novarium-code-task-test",
      workspace: "C:/nonexistent-novarium-code-task-test/source",
    }),
    createSnapshot: async () => ({ text: "source" }),
    advisorRequesters: {
      gemini: async ({ input, outputSchema }) => {
        if (outputSchema) {
          planCalls.push("gemini");
          return { model: "gemini-code-model", text: JSON.stringify(plan) };
        }
        return advisor("gemini")({ input });
      },
    },
    resolveGitHubSession: async () => githubSession,
    createConfirmation: async () => ({
      id: "22222222-2222-4222-8222-222222222222",
      expiresAt: Date.now() + 60_000,
    }),
  });
  assert.deepEqual(planCalls, ["gemini"]);
  assert.match(prepared.output, /Водещ кодов изпълнител: Vertex Gemini \(gemini-code-model\)/u);
});

test("confirmation creates exactly one branch commit and pull request operation", async () => {
  let storedConfirmation;
  const prepared = await prepareCodeTask({
    ownerId: "owner-1",
    sessionId: "session-1",
    githubSessionId: "github-session",
    message: "Добави проверим UI модул.",
    env: vertexEnv,
    createWorkspace: async () => ({
      root: "C:/nonexistent-novarium-code-task-test",
      workspace: "C:/nonexistent-novarium-code-task-test/source",
    }),
    createSnapshot: async () => ({ text: "source" }),
    advisorRequesters: {
      gemini: async ({ outputSchema }) =>
        outputSchema
          ? { model: "gemini-code-model", text: JSON.stringify(plan) }
          : advisor("gemini")(),
    },
    resolveGitHubSession: async () => githubSession,
    createConfirmation: async (confirmation) => {
      storedConfirmation = {
        id: "22222222-2222-4222-8222-222222222222",
        ...confirmation,
      };
      return { id: storedConfirmation.id, expiresAt: Date.now() + 60_000 };
    },
  });

  let consumed = false;
  let writeCalls = 0;
  const result = await confirmCodeTask({
    ownerId: "owner-1",
    sessionId: "session-1",
    githubSessionId: "github-session",
    confirmationId: prepared.confirmationId,
    resolveGitHubSession: async () => githubSession,
    validateConfirmation: async () => storedConfirmation,
    consumeConfirmation: async () => {
      consumed = true;
    },
    executeWrite: async ({ execute }) => {
      assert.equal(consumed, true);
      return execute();
    },
    createPullRequest: async (input) => {
      writeCalls += 1;
      assert.equal(input.base, "main");
      assert.notEqual(input.branchName, "main");
      assert.deepEqual(input.changes, plan.changes);
      return {
        repository: input.repository,
        branch: input.branchName,
        base: input.base,
        commitSha: "abc123",
        pullRequestNumber: 42,
        url: "https://github.test/pull/42",
        changedFiles: input.changes.map(({ path }) => path),
      };
    },
  });

  assert.equal(writeCalls, 1);
  assert.equal(result.pullRequestNumber, 42);
});

test("code task stops when no engine is configured", async () => {
  await assert.rejects(
    () =>
      prepareCodeTask({
        ownerId: "owner-1",
        sessionId: "session-1",
        githubSessionId: "github-session",
        message: "Промени интерфейса.",
        apiKey: "",
        env: {},
        resolveGitHubSession: async () => githubSession,
      }),
    (error) => error.code === "CODE_TASK_COUNCIL_NOT_CONFIGURED",
  );
});

test("normalizes safe repository-relative paths returned by the coding model", async () => {
  let storedConfirmation;
  const prepared = await prepareCodeTask({
    ownerId: "owner-1",
    sessionId: "session-1",
    githubSessionId: "github-session",
    message: "Подобри интерфейса за аватарите.",
    env: vertexEnv,
    createWorkspace: async () => ({
      root: "C:/nonexistent-novarium-code-task-test",
      workspace: "C:/nonexistent-novarium-code-task-test/source",
    }),
    createSnapshot: async () => ({ text: "public/app.js\n// source" }),
    advisorRequesters: {
      gemini: async ({ outputSchema }) =>
        outputSchema
          ? {
              model: "gemini-code-model",
              text: JSON.stringify({
                ...plan,
                changes: [
                  {
                    ...plan.changes[0],
                    path: ".\\public\\avatar-proof.js",
                  },
                ],
              }),
            }
          : advisor("gemini")(),
    },
    resolveGitHubSession: async () => githubSession,
    createConfirmation: async (confirmation) => {
      storedConfirmation = confirmation;
      return {
        id: "33333333-3333-4333-8333-333333333333",
        expiresAt: Date.now() + 60_000,
      };
    },
  });

  assert.equal(prepared.files[0].path, "public/avatar-proof.js");
  assert.equal(
    storedConfirmation.params.changes[0].path,
    "public/avatar-proof.js",
  );
});

test("blocks a coding plan that collapses a large existing file", async () => {
  const root = await mkdtemp(join(tmpdir(), "novarium-rewrite-guard-"));
  const workspace = join(root, "source");
  await mkdir(join(workspace, "public"), { recursive: true });
  await writeFile(
    join(workspace, "public", "work-mode.css"),
    Array.from(
      { length: 80 },
      (_, index) => `.rule-${index} { color: #123; }`,
    ).join("\n"),
  );

  await assert.rejects(
    () =>
      prepareCodeTask({
        ownerId: "owner-1",
        sessionId: "session-1",
        githubSessionId: "github-session",
        message: "Подобри избрания аватар.",
        env: vertexEnv,
        createWorkspace: async () => ({ root, workspace }),
        createSnapshot: async () => ({ text: "public/work-mode.css" }),
        advisorRequesters: {
          gemini: async ({ outputSchema }) =>
            outputSchema
              ? {
                  model: "gemini-code-model",
                  text: JSON.stringify({
                    ...plan,
                    changes: [
                      {
                        path: "public/work-mode.css",
                        content: ".work-choice-card.active{background:#f0faf4}",
                        reason: "Минимална визуална промяна.",
                      },
                    ],
                  }),
                }
              : advisor("gemini")(),
        },
        resolveGitHubSession: async () => githubSession,
      }),
    (error) => error.code === "CODE_TASK_EXCESSIVE_REWRITE",
  );
});
