import test from "node:test";
import assert from "node:assert/strict";
import {
  CapabilityError,
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
