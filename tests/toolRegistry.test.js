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
  assert.equal(listTools().length, 8);
  assert.deepEqual(getTool("github-read").capabilities, [
    "code.read",
    "code.search",
    "commit.read",
  ]);
  assert.equal(getTool("github-write").enabled, true);
  assert.equal(getTool("github-write").requiresConfirmation, true);
  assert.deepEqual(getTool("supabase-status").capabilities, [
    "database.status",
  ]);
});

test("намира активен и здрав инструмент по способност", () => {
  registerCoreTools();
  assert.equal(
    findToolsByCapability("calendar.read")[0].id,
    "google-calendar-read",
  );
});

test("не допуска дублиран id", () => {
  registerCoreTools();
  assert.throws(() => registerTool(getTool("github-read")), /дублиран id/u);
});
