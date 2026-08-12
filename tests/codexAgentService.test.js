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
  createBoundedSourceSnapshot,
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

test("Codex analysis uses a bounded source request without local command execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-runtime-test-"));
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "src", "routes"), { recursive: true });
  await writeFile(join(workspace, "AGENTS.md"), "Project rules.");
  await writeFile(join(workspace, "package.json"), '{"name":"safe"}');
  await writeFile(
    join(workspace, "src", "routes", "chat.js"),
    "export function chat() { return 'safe'; }",
  );
  let requestOptions;
  let prompt;

  const result = await runCodexProjectAnalysis({
    message: "Провери маршрута за чат.",
    projectId: "project-1",
    projectName: "AI CORE",
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
    responseRequester: async (options) => {
      requestOptions = options;
      prompt = options.input[0].content;
      return {
        text: JSON.stringify({
          status: "ready_for_next_step",
          summary: "Маршрутът е проверен.",
          evidence: ["src/routes/chat.js използва Capability Engine."],
          nextStep: "Добави целеви тест.",
          needsUserDecision: false,
        }),
      };
    },
    createWorkspace: async () => ({ root, workspace, files: 2 }),
  });

  assert.match(result.output, /Резултат: Маршрутът е проверен/u);
  assert.match(result.output, /Следваща стъпка: Добави целеви тест/u);
  assert.equal(result.projectRun.projectId, "project-1");
  assert.equal(result.projectRun.sequence, 3);
  assert.equal(result.projectRun.codeChanged, false);
  assert.equal(requestOptions.apiKey, "test-openai-key");
  assert.equal(requestOptions.signal instanceof AbortSignal, true);
  assert.equal(requestOptions.reasoningEffort, "medium");
  assert.equal(requestOptions.outputSchema.additionalProperties, false);
  assert.doesNotMatch(prompt, /must-never-reach-child|test-openai-key/u);
  assert.match(prompt, /src\/routes\/chat\.js/u);
  assert.match(prompt, /return 'safe'/u);
  assert.match(prompt, /Нямаш shell/u);
  assert.match(prompt, /кодът още не е променен/u);
  assert.match(prompt, /ПРЕДИШЕН ПРОВЕРЕН РЕЗУЛТАТ/u);
  await assert.rejects(access(root));
});

test("Codex blocks a final response containing a configured secret", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-secret-test-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const secret = "private-token-value-123";

  await writeFile(join(workspace, "package.json"), '{"name":"safe"}');

  await assert.rejects(
    () =>
      runCodexReadAnalysis({
        message: "Провери.",
        apiKey: "test-openai-key",
        env: { SERVICE_TOKEN: secret },
        responseRequester: async () => ({
          text: JSON.stringify({
            status: "blocked",
            summary: `Намерих ${secret}`,
            evidence: [],
            nextStep: "Спри.",
            needsUserDecision: true,
          }),
        }),
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

  await writeFile(join(workspace, "package.json"), '{"name":"safe"}');

  const output = await runCodexReadAnalysis({
    message: "Провери.",
    apiKey: "test-openai-key",
    responseRequester: async () => ({
      text: JSON.stringify({
        status: "complete",
        summary: "Проверката приключи.",
        evidence: [],
        nextStep: "",
        needsUserDecision: false,
      }),
    }),
    createWorkspace: async () => ({ root, workspace, files: 1 }),
  });

  assert.match(output, /Резултат: Проверката приключи/u);
  assert.match(output, /Кодът не е променян/u);
});

test("bounded source snapshots prioritize the requested file and redact tokens", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "codex-snapshot-test-"));
  await mkdir(join(workspace, "src", "routes"), { recursive: true });
  await mkdir(join(workspace, "docs"), { recursive: true });
  await writeFile(
    join(workspace, "src", "routes", "chat.js"),
    [
      'const apiKey = "sk_test_12345678901234567890";',
      'const config = { "password": "super-secret-value" };',
      "export const chat = true;",
    ].join("\n"),
  );
  await writeFile(join(workspace, "docs", "unrelated.md"), "Other notes.");

  try {
    const snapshot = await createBoundedSourceSnapshot({
      workspace,
      message: "Провери src/routes/chat.js",
      projectObjective: "",
    });
    assert.equal(snapshot.includedPaths[0], "src/routes/chat.js");
    assert.match(snapshot.text, /REDACTED_SECRET/u);
    assert.doesNotMatch(snapshot.text, /sk_test_12345678901234567890/u);
    assert.doesNotMatch(snapshot.text, /super-secret-value/u);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("bounded source snapshots enforce file and byte limits", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "codex-limit-test-"));
  await mkdir(join(workspace, "src"), { recursive: true });
  try {
    await Promise.all(
      Array.from({ length: 70 }, (_, index) =>
        writeFile(
          join(workspace, "src", `module-${String(index).padStart(2, "0")}.js`),
          `export const value${index} = "${"x".repeat(10000)}";`,
        ),
      ),
    );
    const snapshot = await createBoundedSourceSnapshot({
      workspace,
      message: "Направи общ анализ.",
      projectObjective: "",
    });
    assert.ok(snapshot.includedPaths.length <= 64);
    assert.ok(snapshot.bytes <= 480000);
    assert.ok(Buffer.byteLength(snapshot.text, "utf8") <= 521000);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
