import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CodexAgentError,
  createIsolatedSourceWorkspace,
  isCodexAgentConfigured,
  runCodexProjectAnalysis,
  runCodexReadAnalysis,
} from "../src/services/codexAgentService.js";

test("Codex configuration reuses the OpenAI key and has an explicit kill switch", () => {
  assert.equal(isCodexAgentConfigured({ OPENAI_API_KEY: "key" }), true);
  assert.equal(
    isCodexAgentConfigured({
      OPENAI_API_KEY: "key",
      CODEX_AGENT_ENABLED: "false",
    }),
    false,
  );
  assert.equal(isCodexAgentConfigured({}), false);
});

test("isolated Codex workspace copies source but excludes secrets and dependencies", async () => {
  const source = await mkdtemp(join(tmpdir(), "codex-source-test-"));
  await mkdir(join(source, "src"), { recursive: true });
  await mkdir(join(source, "node_modules", "unsafe"), { recursive: true });
  await writeFile(join(source, "package.json"), '{"name":"safe"}');
  await writeFile(join(source, "src", "index.js"), "export const ok = true;");
  await writeFile(join(source, ".env"), "OPENAI_API_KEY=must-not-copy");
  await writeFile(join(source, "node_modules", "unsafe", "index.js"), "bad");

  const isolated = await createIsolatedSourceWorkspace(source);
  try {
    assert.equal(
      await readFile(join(isolated.workspace, "package.json"), "utf8"),
      '{"name":"safe"}',
    );
    assert.equal(
      await readFile(join(isolated.workspace, "src", "index.js"), "utf8"),
      "export const ok = true;",
    );
    await assert.rejects(access(join(isolated.workspace, ".env")));
    await assert.rejects(access(join(isolated.workspace, "node_modules")));
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(isolated.root, { recursive: true, force: true });
  }
});

test("Codex analysis is forced into read-only, offline, isolated execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-runtime-test-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  let clientOptions;
  let threadOptions;
  let turnOptions;
  let prompt;

  class FakeCodex {
    constructor(options) {
      clientOptions = options;
    }

    startThread(options) {
      threadOptions = options;
      return {
        async run(input, options) {
          prompt = input;
          turnOptions = options;
          return {
            finalResponse: JSON.stringify({
              status: "ready_for_next_step",
              summary: "Маршрутът е проверен.",
              evidence: ["src/routes/chat.js използва Capability Engine."],
              nextStep: "Добави целеви тест.",
              needsUserDecision: false,
            }),
          };
        },
      };
    }
  }

  const result = await runCodexProjectAnalysis({
    message: "Провери маршрута за чат.",
    projectId: "project-1",
    projectName: "SYNCHRON-X",
    previousRun: {
      sequence: 2,
      summary: "Преди това беше проверен work mode.",
      nextStep: "Провери маршрута.",
    },
    apiKey: "test-openai-key",
    env: {
      PATH: "/usr/bin:/bin",
      OTHER_SECRET: "must-never-reach-child",
    },
    sdkLoader: async () => ({ Codex: FakeCodex }),
    createWorkspace: async () => ({ root, workspace, files: 2 }),
  });

  assert.match(result.output, /Резултат: Маршрутът е проверен/u);
  assert.match(result.output, /Следваща стъпка: Добави целеви тест/u);
  assert.equal(result.projectRun.projectId, "project-1");
  assert.equal(result.projectRun.sequence, 3);
  assert.equal(result.projectRun.codeChanged, false);
  assert.equal(threadOptions.sandboxMode, "read-only");
  assert.equal(threadOptions.networkAccessEnabled, false);
  assert.equal(threadOptions.webSearchMode, "disabled");
  assert.equal(threadOptions.approvalPolicy, "never");
  assert.equal(threadOptions.workingDirectory, workspace);
  assert.equal(turnOptions.signal instanceof AbortSignal, true);
  assert.equal(turnOptions.outputSchema.additionalProperties, false);
  assert.equal(clientOptions.apiKey, "test-openai-key");
  assert.deepEqual(Object.keys(clientOptions.env).sort(), [
    "HOME",
    "LANG",
    "PATH",
    "TMPDIR",
  ]);
  assert.doesNotMatch(prompt, /must-never-reach-child|test-openai-key/u);
  assert.match(prompt, /кодът още не е променен/u);
  assert.match(prompt, /ПРЕДИШЕН ПРОВЕРЕН РЕЗУЛТАТ/u);
  await assert.rejects(access(root));
});

test("Codex blocks a final response containing a configured secret", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-secret-test-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const secret = "private-token-value-123";

  class FakeCodex {
    startThread() {
      return {
        async run() {
          return {
            finalResponse: JSON.stringify({
              status: "blocked",
              summary: `Намерих ${secret}`,
              evidence: [],
              nextStep: "Спри.",
              needsUserDecision: true,
            }),
          };
        },
      };
    }
  }

  await assert.rejects(
    () =>
      runCodexReadAnalysis({
        message: "Провери.",
        apiKey: "test-openai-key",
        env: { SERVICE_TOKEN: secret },
        sdkLoader: async () => ({ Codex: FakeCodex }),
        createWorkspace: async () => ({ root, workspace, files: 1 }),
      }),
    (error) =>
      error instanceof CodexAgentError &&
      error.code === "CODEX_AGENT_SECRET_BLOCKED",
  );
  await assert.rejects(access(root));
});

test("Codex fails closed when no API key is configured", async () => {
  await assert.rejects(
    () => runCodexReadAnalysis({ message: "Провери.", apiKey: "" }),
    (error) =>
      error instanceof CodexAgentError &&
      error.code === "CODEX_AGENT_NOT_CONFIGURED",
  );
});

test("Codex read compatibility returns the formatted project result", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-compat-test-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);

  class FakeCodex {
    startThread() {
      return {
        async run() {
          return {
            finalResponse: JSON.stringify({
              status: "complete",
              summary: "Проверката приключи.",
              evidence: [],
              nextStep: "",
              needsUserDecision: false,
            }),
          };
        },
      };
    }
  }

  const output = await runCodexReadAnalysis({
    message: "Провери.",
    apiKey: "test-openai-key",
    sdkLoader: async () => ({ Codex: FakeCodex }),
    createWorkspace: async () => ({ root, workspace, files: 1 }),
  });

  assert.match(output, /Резултат: Проверката приключи/u);
  assert.match(output, /Кодът не е променян/u);
});
