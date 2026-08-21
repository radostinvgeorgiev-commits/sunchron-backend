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
const plan = {
  title: "Подобри интерфейса за аватари",
  summary: "Добавя по-ясен избор и визуално състояние за аватарите.",
  commitMessage: "Improve avatar selection UI",
  pullRequestBody: "AI CORE multi-engine code task.",
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

test("three engines are consulted before a bounded code confirmation is created", async () => {
  let storedConfirmation;
  const prepared = await prepareCodeTask({
    ownerId: "owner-1",
    sessionId: "session-1",
    githubSessionId: "github-session",
    message: "Подобри интерфейса за аватарите.",
    apiKey: "openai-key",
    geminiApiKey: "gemini-key",
    grokApiKey: "grok-key",
    createWorkspace: async () => ({
      root: "C:/nonexistent-ai-core-code-task-test",
      workspace: "C:/nonexistent-ai-core-code-task-test/source",
    }),
    createSnapshot: async () => ({ text: "public/app.js\n// source" }),
    advisorRequesters: {
      openai: advisor("openai"),
      gemini: advisor("gemini"),
      grok: advisor("grok"),
    },
    responseRequester: async ({ input }) => {
      assert.match(input[0].content, /openai \/ openai-test-model/u);
      assert.match(input[0].content, /gemini \/ gemini-test-model/u);
      assert.match(input[0].content, /grok \/ grok-test-model/u);
      assert.match(input[0].content, /public\/work-mode\.js/u);
      assert.match(input[0].content, /Не добавяй конкурентен picker/u);
      return { text: JSON.stringify(plan) };
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
    ["openai", "gemini", "grok"],
  );
  assert.equal(prepared.files[0].path, "public/avatar-proof.js");
  assert.equal(storedConfirmation.action, "github.write:code_task");
  assert.match(prepared.output, /Още не е записано нищо/u);
  assert.match(prepared.output, /Водещ кодов изпълнител: Codex/u);
  assert.equal(
    extractCodeTaskConfirmationId(
      `Потвърждавам AI CORE кодова задача: ${prepared.confirmationId}`,
    ),
    prepared.confirmationId,
  );
});

test("confirmation creates exactly one branch commit and pull request operation", async () => {
  let storedConfirmation;
  const prepared = await prepareCodeTask({
    ownerId: "owner-1",
    sessionId: "session-1",
    githubSessionId: "github-session",
    message: "Добави проверим UI модул.",
    apiKey: "openai-key",
    geminiApiKey: "gemini-key",
    grokApiKey: "grok-key",
    createWorkspace: async () => ({
      root: "C:/nonexistent-ai-core-code-task-test",
      workspace: "C:/nonexistent-ai-core-code-task-test/source",
    }),
    createSnapshot: async () => ({ text: "source" }),
    advisorRequesters: {
      openai: advisor("openai"),
      gemini: advisor("gemini"),
      grok: advisor("grok"),
    },
    responseRequester: async () => ({ text: JSON.stringify(plan) }),
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

test("code task fails closed unless all three engines are configured", async () => {
  await assert.rejects(
    () =>
      prepareCodeTask({
        ownerId: "owner-1",
        sessionId: "session-1",
        githubSessionId: "github-session",
        message: "Промени интерфейса.",
        apiKey: "openai-key",
        geminiApiKey: "",
        grokApiKey: "grok-key",
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
    apiKey: "openai-key",
    geminiApiKey: "gemini-key",
    grokApiKey: "grok-key",
    createWorkspace: async () => ({
      root: "C:/nonexistent-ai-core-code-task-test",
      workspace: "C:/nonexistent-ai-core-code-task-test/source",
    }),
    createSnapshot: async () => ({ text: "public/app.js\n// source" }),
    advisorRequesters: {
      openai: advisor("openai"),
      gemini: advisor("gemini"),
      grok: advisor("grok"),
    },
    responseRequester: async () => ({
      text: JSON.stringify({
        ...plan,
        changes: [{ ...plan.changes[0], path: ".\\public\\avatar-proof.js" }],
      }),
    }),
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
  const root = await mkdtemp(join(tmpdir(), "ai-core-rewrite-guard-"));
  const workspace = join(root, "source");
  await mkdir(join(workspace, "public"), { recursive: true });
  await writeFile(
    join(workspace, "public", "work-mode.css"),
    Array.from({ length: 80 }, (_, index) => `.rule-${index} { color: #123; }`).join("\n"),
  );

  await assert.rejects(
    () =>
      prepareCodeTask({
        ownerId: "owner-1",
        sessionId: "session-1",
        githubSessionId: "github-session",
        message: "Подобри избрания аватар.",
        apiKey: "openai-key",
        geminiApiKey: "gemini-key",
        grokApiKey: "grok-key",
        createWorkspace: async () => ({ root, workspace }),
        createSnapshot: async () => ({ text: "public/work-mode.css" }),
        advisorRequesters: {
          openai: advisor("openai"),
          gemini: advisor("gemini"),
          grok: advisor("grok"),
        },
        responseRequester: async () => ({
          text: JSON.stringify({
            ...plan,
            changes: [
              {
                path: "public/work-mode.css",
                content: ".pet-choice.active{background:#f0faf4}",
                reason: "Минимална визуална промяна.",
              },
            ],
          }),
        }),
        resolveGitHubSession: async () => githubSession,
      }),
    (error) => error.code === "CODE_TASK_EXCESSIVE_REWRITE",
  );
});
