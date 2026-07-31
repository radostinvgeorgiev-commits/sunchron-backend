import assert from "node:assert/strict";
import test from "node:test";

import {
  formatMemoryAcceptanceReport,
  runMemoryAcceptanceTest,
} from "../src/services/memoryAcceptanceService.js";

function createMemoryDouble() {
  const owners = new Map();
  const listFor = (ownerId) => owners.get(ownerId) || [];

  return {
    async listProfileMemories({ ownerId }) {
      return listFor(ownerId).map((item) => ({ ...item }));
    },
    async saveProfileMemory(fact, source, scope, ownerId) {
      const existing = listFor(ownerId);
      const id = existing[0]?.id || `record-${owners.size + 1}`;
      const replaced = existing.length > 0 && existing[0].fact !== fact;
      owners.set(ownerId, [
        {
          id,
          fact,
          source,
          scope,
          memoryKey: "personal:property:моят-автоматичен-тестов-код",
        },
      ]);
      return { id, fact, source, scope, replaced };
    },
    async deleteProfileMemoryByFact(fact, _scope, ownerId) {
      const before = listFor(ownerId);
      const after = before.filter((item) => item.fact !== fact);
      owners.set(ownerId, after);
      return before.length - after.length;
    },
    async executeAuditedWriteAction({ execute }) {
      return execute();
    },
    seed(ownerId, items) {
      owners.set(
        ownerId,
        items.map((item) => ({ ...item })),
      );
    },
    allOwners() {
      return owners;
    },
  };
}

test("memory acceptance test uses an isolated owner and leaves real memory unchanged", async () => {
  const memory = createMemoryDouble();
  memory.seed("radko", [
    {
      id: "real-1",
      fact: "Живея във Варна",
      scope: "personal",
      memoryKey: "personal:location:residence",
    },
  ]);
  let guardInput = null;

  const report = await runMemoryAcceptanceTest({
    ownerId: "radko",
    verifyDeleteGuard: async (input) => {
      guardInput = input;
      return true;
    },
    dependencies: memory,
  });

  assert.equal(report.status, "works");
  assert.equal(report.isolated, true);
  assert.equal(report.realMemoryUnchanged, true);
  assert.equal(report.cleanupCompleted, true);
  assert.ok(report.steps.some((step) => step.id === "read-new-session"));
  assert.ok(report.steps.some((step) => step.id === "verify-replacement"));
  assert.ok(
    report.steps.some((step) => step.id === "delete-without-confirmation"),
  );
  assert.ok(
    report.steps.some(
      (step) =>
        step.id === "one-time-confirmed-cleanup" &&
        step.reusable === false,
    ),
  );
  assert.match(guardInput.ownerId, /^memory-self-test:radko:/u);
  assert.deepEqual(memory.allOwners().get("radko"), [
    {
      id: "real-1",
      fact: "Живея във Варна",
      scope: "personal",
      memoryKey: "personal:location:residence",
    },
  ]);
  assert.deepEqual(memory.allOwners().get(guardInput.ownerId), []);

  const output = formatMemoryAcceptanceReport(report);
  assert.match(output, /РАБОТИ/u);
  assert.match(output, /Истинската памет е непроменена: да/u);
});
