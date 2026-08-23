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
  assert.equal(listTools().length, 17);
  assert.deepEqual(getTool("synchron-integrations-status").capabilities, [
    "system.integrations.status",
    "system.tools.read",
    "system.audit.read",
    "system.errors.read",
  ]);
  assert.deepEqual(getTool("synchron-system-inspector").capabilities, [
    "system.configuration.read",
  ]);
  assert.deepEqual(getTool("github-read").capabilities, [
    "code.read",
    "code.search",
    "commit.read",
    "code.task-status",
    "issues.read",
    "pull-requests.read",
    "actions.read",
  ]);
  assert.equal(getTool("github-write").enabled, true);
  assert.equal(getTool("github-write").requiresConfirmation, true);
  assert.equal(getTool("github-write").healthStatus, "unavailable");
  assert.equal(getTool("github-confirmed-write").requiresConfirmation, true);
  assert.deepEqual(getTool("github-confirmed-write").capabilities, [
    "github.branch.create",
    "github.file.create",
    "github.file.update",
    "github.pull-request.create",
    "github.issue.close",
  ]);
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
  assert.equal(getTool("supabase-status"), null);
  assert.deepEqual(getTool("google-firestore-memory").capabilities, [
    "memory.read",
    "memory.search",
    "memory.verify",
    "memory.save",
    "memory.update",
    "memory.delete",
  ]);
  assert.deepEqual(getTool("google-cloud-read").capabilities, [
    "infrastructure.googlecloud.read",
  ]);
  assert.deepEqual(getTool("google-cloud-write").capabilities, [
    "infrastructure.googlecloud.write",
  ]);
  assert.equal(getTool("google-cloud-write").requiresConfirmation, true);
  assert.deepEqual(getTool("synchron-agent-chat").capabilities, [
    "chat.send_message",
    "chat.read_reply",
    "chat.list_threads",
    "chat.read_history",
    "chat.continue_session",
  ]);
  assert.equal(getTool("synchron-tasks").requiresConfirmation, false);
  assert.equal(
    getTool("synchron-tasks").capabilityPermissions["tasks.status"],
    "tasks.update",
  );
  assert.equal(
    getTool("google-contacts").capabilityPermissions["contacts.update"],
    "contacts.write",
  );
  assert.equal(
    getTool("gmail-read").capabilityPermissions["mail.send"],
    "mail.send",
  );
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
