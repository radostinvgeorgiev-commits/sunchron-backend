import assert from "node:assert/strict";
import test from "node:test";

import {
  CapabilityError,
  executeCapability,
  getToolRuntimeAvailability,
  isToolExecutable,
  resolveCapability,
} from "../src/tools/capabilityEngine.js";
import {
  getTool,
  listTools,
  registerCoreTools,
  resetToolRegistryForTests,
} from "../src/tools/toolRegistry.js";

test.beforeEach(() => resetToolRegistryForTests());

test("Google Cloud memory and Identity Platform are the only runtime backends", () => {
  assert.equal(resolveCapability("memory.read").tool.id, "firestore-memory");
  assert.equal(resolveCapability("memory.read").permission.action, "memory.read");
  assert.throws(
    () => resolveCapability("database.status"),
    (error) => error instanceof CapabilityError && error.code === "CAPABILITY_UNAVAILABLE",
  );
});

test("core tools contain no removed infrastructure adapters", () => {
  registerCoreTools();
  const ids = listTools().map(({ id }) => id);
  assert.ok(ids.includes("firestore-memory"));
  assert.ok(!ids.some((id) => /opensearch|supabase|digitalocean|cloudflare/u.test(id)));
  assert.equal(getTool("firestore-memory").provider, "synchron");
});

test("memory delete and external writes still require confirmation", () => {
  assert.equal(resolveCapability("memory.delete").requiresConfirmation, true);
  assert.equal(resolveCapability("github.branch.create").permission.decision, "confirm");
  assert.throws(
    () => resolveCapability("unknown.capability"),
    (error) => error instanceof CapabilityError && error.code === "CAPABILITY_UNAVAILABLE",
  );
});

test("AI chat and Firestore memory are available with Google runtime configuration", () => {
  const env = {
    AI_CORE_PROVIDER: "grok",
    GROK_API_KEY: "key",
    MEMORY_BACKEND: "firestore",
    PERSISTENCE_BACKEND: "firestore",
    AUTH_BACKEND: "identity-platform",
    GOOGLE_CLOUD_PROJECT: "handy-boulevard-479120-q9",
    FIRESTORE_DATABASE_ID: "(default)",
  };
  assert.equal(getToolRuntimeAvailability("synchron-agent-chat", { ownerId: "identity-platform:user-a" }, env).available, true);
  assert.equal(getToolRuntimeAvailability("firestore-memory", { ownerId: "identity-platform:user-a" }, env).available, true);
  assert.equal(isToolExecutable("firestore-memory"), true);
});

test("unconfigured Google Cloud memory fails closed", () => {
  const result = getToolRuntimeAvailability("firestore-memory", {}, {});
  assert.equal(result.available, false);
  assert.equal(result.code, "CAPABILITY_NOT_CONFIGURED");
});

test("confirmation is required before destructive capability execution", async () => {
  await assert.rejects(
    () => executeCapability("memory.delete"),
    (error) => error instanceof CapabilityError && error.code === "CAPABILITY_CONFIRMATION_REQUIRED",
  );
});
