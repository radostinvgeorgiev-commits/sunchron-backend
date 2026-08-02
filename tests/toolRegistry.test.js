import test from "node:test";
import assert from "node:assert/strict";
import {
  findToolsByCapability,
  getTool,
  listTools,
  registerCoreTools,
  registerTool,
  resetToolRegistryForTests,
} from "../src/tools/toolRegistry.js";

test.beforeEach(() => resetToolRegistryForTests());

test("регистрира съществуващите интеграции с пълни метаданни", () => {
  registerCoreTools();
  assert.equal(listTools().length, 14);
  assert.deepEqual(getTool("synchron-integrations-status").capabilities, [
    "system.integrations.status",
  ]);
  assert.deepEqual(getTool("synchron-system-inspector").capabilities, [
    "system.configuration.read",
  ]);
  assert.deepEqual(getTool("github-read").capabilities, [
    "code.read",
    "code.search",
    "commit.read",
    "code.task-status",
  ]);
  assert.equal(getTool("github-write").enabled, true);
  assert.equal(getTool("github-write").requiresConfirmation, true);
  assert.equal(getTool("github-write").healthStatus, "unavailable");
  assert.deepEqual(getTool("openai-codex").capabilities, ["code.analyze"]);
  assert.equal(getTool("openai-codex").requiresConfirmation, false);
  assert.equal(
    getTool("openai-codex").capabilityPermissions["code.analyze"],
    "code.execute.read",
  );
  assert.equal(getTool("google-calendar-write").requiresConfirmation, true);
  assert.deepEqual(getTool("google-calendar-write").capabilities, [
    "calendar.write",
  ]);
  assert.deepEqual(getTool("supabase-status").capabilities, [
    "database.status",
  ]);
  assert.deepEqual(getTool("digitalocean-read").capabilities, [
    "infrastructure.digitalocean.read",
  ]);
  assert.deepEqual(getTool("cloudflare-read").capabilities, [
    "infrastructure.cloudflare.read",
  ]);
});

test("core registry is fail-closed until runtime availability is checked", () => {
  registerCoreTools();
  assert.equal(findToolsByCapability("calendar.read").length, 0);
  assert.equal(
    findToolsByCapability("calendar.read", { healthyOnly: false })[0].id,
    "google-calendar-read",
  );
});

test("не допуска дублиран id", () => {
  registerCoreTools();
  assert.throws(() => registerTool(getTool("github-read")), /дублиран id/u);
});
