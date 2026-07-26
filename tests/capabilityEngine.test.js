import test from "node:test";
import assert from "node:assert/strict";
import {
  CapabilityError,
  executeCapability,
  resolveCapability,
} from "../src/tools/capabilityEngine.js";
import { resetToolRegistryForTests } from "../src/tools/toolRegistry.js";

test.beforeEach(() => resetToolRegistryForTests());

test("избира GitHub без AI Core да знае конкретния инструмент", () => {
  const result = resolveCapability("code.read");
  assert.equal(result.tool.id, "github-read");
  assert.equal(result.permission.decision, "allow");
  assert.equal(result.requiresConfirmation, false);
});

test("маркира опасните действия за потвърждение", () => {
  const result = resolveCapability("memory.delete");
  assert.equal(result.permission.decision, "confirm");
  assert.equal(result.requiresConfirmation, true);
});

test("блокира липсваща способност по подразбиране", () => {
  assert.throws(
    () => resolveCapability("bank.transfer"),
    (error) =>
      error instanceof CapabilityError &&
      error.code === "CAPABILITY_UNAVAILABLE",
  );
});

test("изпълнява GitHub четене чрез избрания инструмент", async () => {
  const originalFetch = global.fetch;
  const originalApiUrl = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = "https://github.test";
  global.fetch = async () =>
    new Response(
      JSON.stringify([
        {
          sha: "fa21ebb1234567890",
          commit: {
            message: "Capability Core",
            author: { name: "Codex", date: "2026-07-26T00:00:00Z" },
          },
          html_url: "https://github.test/commit/fa21ebb",
        },
      ]),
      { status: 200 },
    );

  try {
    const result = await executeCapability("code.read", {
      message: "Покажи последните commit-и в GitHub.",
    });
    assert.equal(result.tool.id, "github-read");
    assert.match(result.output, /fa21ebb/u);
  } finally {
    global.fetch = originalFetch;
    if (originalApiUrl === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = originalApiUrl;
  }
});

test("не изпълнява способност за потвърждение без разрешение", async () => {
  await assert.rejects(
    () => executeCapability("memory.delete"),
    (error) =>
      error instanceof CapabilityError &&
      error.code === "CAPABILITY_CONFIRMATION_REQUIRED",
  );
});
