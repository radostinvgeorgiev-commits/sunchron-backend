import { createHash, randomUUID } from "node:crypto";

import {
  deleteProfileMemoryByFact,
  listProfileMemories,
  saveProfileMemory,
} from "./memoryService.js";
import {
  confirmMemoryDelete,
  prepareMemoryDelete,
} from "./memoryDeleteConfirmationService.js";

function memoryFingerprint(memories) {
  const stableView = memories
    .map(({ id, fact, scope, memoryKey }) => ({
      id: id || null,
      fact: fact || "",
      scope: scope || "personal",
      memoryKey: memoryKey || null,
    }))
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
  return createHash("sha256").update(JSON.stringify(stableView)).digest("hex");
}

function completedStep(id, evidence = {}) {
  return Object.freeze({
    id,
    status: "passed",
    timestamp: new Date().toISOString(),
    ...evidence,
  });
}

export class MemoryAcceptanceError extends Error {
  constructor(message, report) {
    super(message);
    this.name = "MemoryAcceptanceError";
    this.code = "MEMORY_ACCEPTANCE_FAILED";
    this.report = report;
  }
}

export async function runMemoryAcceptanceTest({
  ownerId,
  verifyDeleteGuard,
  dependencies = {},
} = {}) {
  if (typeof ownerId !== "string" || !ownerId.trim()) {
    throw new MemoryAcceptanceError(
      "Липсва собственик за изолирания тест на паметта.",
      null,
    );
  }
  if (typeof verifyDeleteGuard !== "function") {
    throw new MemoryAcceptanceError(
      "Липсва проверка на защитата преди изтриване.",
      null,
    );
  }

  const save = dependencies.saveProfileMemory || saveProfileMemory;
  const list = dependencies.listProfileMemories || listProfileMemories;
  const remove =
    dependencies.deleteProfileMemoryByFact || deleteProfileMemoryByFact;
  const prepareDelete = dependencies.prepareMemoryDelete || prepareMemoryDelete;
  const confirmDelete = dependencies.confirmMemoryDelete || confirmMemoryDelete;
  const runId = randomUUID();
  const testOwnerId = `memory-self-test:${ownerId}:${runId}`;
  const testSessionId = `memory-self-test-session:${runId}`;
  const testCode = runId.slice(0, 8).toUpperCase();
  const initialFact = `Моят автоматичен тестов код е ${testCode}-A`;
  const updatedFact = `Моят автоматичен тестов код е ${testCode}-B`;
  const startedAt = new Date().toISOString();
  const steps = [];
  let activeFact = initialFact;
  let testRecordId = null;
  let primaryError = null;
  let cleanupError = null;
  let realMemoryUnchanged = false;
  let realMemoryBefore = null;

  try {
    const before = await list({ ownerId, scope: "personal" });
    realMemoryBefore = memoryFingerprint(before);
    steps.push(
      completedStep("real-memory-baseline", { recordCount: before.length }),
    );

    const saved = await save(
      initialFact,
      "memory-self-test",
      "personal",
      testOwnerId,
    );
    testRecordId = saved.id;
    steps.push(
      completedStep("create", {
        recordId: saved.id,
        isolatedOwner: true,
      }),
    );

    const createdView = await list({
      ownerId: testOwnerId,
      scope: "personal",
    });
    if (!createdView.some((memory) => memory.fact === initialFact)) {
      throw new Error("Новият тестов запис не беше намерен.");
    }
    steps.push(completedStep("read-new-session", { exactMatch: true }));

    const updated = await save(
      updatedFact,
      "memory-self-test",
      "personal",
      testOwnerId,
    );
    activeFact = updatedFact;
    if (!updated.replaced) {
      throw new Error("Промяната не беше отчетена като замяна.");
    }
    steps.push(
      completedStep("update", {
        recordId: updated.id,
        replaced: true,
      }),
    );

    const updatedView = await list({
      ownerId: testOwnerId,
      scope: "personal",
    });
    const oldValuePresent = updatedView.some(
      (memory) => memory.fact === initialFact,
    );
    const newValuePresent = updatedView.some(
      (memory) => memory.fact === updatedFact,
    );
    if (oldValuePresent || !newValuePresent) {
      throw new Error(
        "След промяната се връща стара или липсва новата стойност.",
      );
    }
    steps.push(
      completedStep("verify-replacement", {
        oldValuePresent: false,
        newValuePresent: true,
      }),
    );

    const guardRejected = await verifyDeleteGuard({
      fact: updatedFact,
      scope: "personal",
      ownerId: testOwnerId,
    });
    if (guardRejected !== true) {
      throw new Error("Изтриването без потвърждение не беше отказано.");
    }
    steps.push(
      completedStep("delete-without-confirmation", { rejected: true }),
    );

    const preparedDelete = await prepareDelete({
      sessionId: testSessionId,
      ownerId: testOwnerId,
      target: { kind: "fact", fact: updatedFact, scope: "personal" },
    });
    if (!preparedDelete.confirmationId) {
      throw new Error("Еднократното потвърждение не беше подготвено.");
    }

    const confirmedDelete = await confirmDelete({
      confirmationId: preparedDelete.confirmationId,
      sessionId: testSessionId,
      ownerId: testOwnerId,
      expectedTarget: preparedDelete.target,
      deleteByFact: remove,
    });
    if (confirmedDelete.deleted < 1) {
      throw new Error("Потвърденото почистване не изтри тестовия запис.");
    }
    let reusable = true;
    try {
      await confirmDelete({
        confirmationId: preparedDelete.confirmationId,
        sessionId: testSessionId,
        ownerId: testOwnerId,
        expectedTarget: preparedDelete.target,
        deleteByFact: remove,
      });
    } catch {
      reusable = false;
    }
    if (reusable) {
      throw new Error("Използваното потвърждение остана активно.");
    }
    steps.push(
      completedStep("one-time-confirmed-cleanup", {
        deleted: confirmedDelete.deleted,
        reusable,
      }),
    );

    const finalTestView = await list({
      ownerId: testOwnerId,
      scope: "personal",
    });
    if (
      finalTestView.some(
        (memory) => memory.fact === initialFact || memory.fact === updatedFact,
      )
    ) {
      throw new Error("Тестовият запис се връща след почистването.");
    }
    steps.push(completedStep("verify-absent", { absent: true }));
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      await remove(activeFact, "personal", testOwnerId);
      if (activeFact !== initialFact) {
        await remove(initialFact, "personal", testOwnerId);
      }
    } catch (error) {
      cleanupError = error;
    }

    try {
      const after = await list({ ownerId, scope: "personal" });
      realMemoryUnchanged =
        realMemoryBefore !== null &&
        realMemoryBefore === memoryFingerprint(after);
      if (realMemoryBefore !== null) {
        steps.push(
          completedStep("real-memory-unchanged", {
            unchanged: realMemoryUnchanged,
            recordCount: after.length,
          }),
        );
      }
    } catch (error) {
      primaryError ||= error;
    }
  }

  const finishedAt = new Date().toISOString();
  const report = Object.freeze({
    status:
      !primaryError && !cleanupError && realMemoryUnchanged
        ? "works"
        : "failed",
    runId,
    recordId: testRecordId,
    startedAt,
    finishedAt,
    isolated: true,
    realMemoryUnchanged,
    cleanupCompleted: !cleanupError,
    steps: Object.freeze(steps),
  });

  if (primaryError || cleanupError || !realMemoryUnchanged) {
    throw new MemoryAcceptanceError(
      primaryError?.message ||
        cleanupError?.message ||
        "Не беше доказано, че истинската памет е останала непроменена.",
      report,
    );
  }

  return report;
}

export function formatMemoryAcceptanceReport(report) {
  const durationMs = Math.max(
    0,
    new Date(report.finishedAt).getTime() -
      new Date(report.startedAt).getTime(),
  );
  return [
    "Автоматичният тест на постоянната памет приключи: РАБОТИ.",
    `Тест: ${report.runId}.`,
    `Тестов запис: ${report.recordId}.`,
    `Проверки: ${report.steps.length} успешни.`,
    "Доказано: запис, извличане в отделен контекст, промяна, отказ без потвърждение, изтриване и липса след изтриването.",
    `Истинската памет е непроменена: ${report.realMemoryUnchanged ? "да" : "не"}.`,
    `Почистването е завършено: ${report.cleanupCompleted ? "да" : "не"}.`,
    `Време: ${durationMs} ms.`,
  ].join("\n");
}
