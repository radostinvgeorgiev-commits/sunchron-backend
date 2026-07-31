import { runMemoryAcceptanceTest } from "./memoryAcceptanceService.js";

const DEFAULT_RETRY_DELAYS_MS = Object.freeze([0, 2_000, 5_000]);

function initialState() {
  return Object.freeze({
    status: "not-started",
    ready: false,
    attempts: 0,
    startedAt: null,
    finishedAt: null,
    isolated: true,
    realMemoryUnchanged: null,
    cleanupCompleted: null,
    passedSteps: 0,
    errorCode: null,
  });
}

let verificationState = initialState();
let activeVerification = null;

function publicReport(status, report, attempts, errorCode = null) {
  return Object.freeze({
    status,
    ready: status === "works",
    attempts,
    startedAt: report?.startedAt || verificationState.startedAt,
    finishedAt: report?.finishedAt || new Date().toISOString(),
    isolated: report?.isolated !== false,
    realMemoryUnchanged: report?.realMemoryUnchanged ?? null,
    cleanupCompleted: report?.cleanupCompleted ?? null,
    passedSteps: Array.isArray(report?.steps)
      ? report.steps.filter((step) => step.status === "passed").length
      : 0,
    errorCode,
  });
}

export function getMemoryStartupVerificationStatus() {
  return verificationState;
}

export function resetMemoryStartupVerificationForTests() {
  verificationState = initialState();
  activeVerification = null;
}

export function startMemoryStartupVerification({
  ownerId,
  verifyDeleteGuard,
  runAcceptanceTest = runMemoryAcceptanceTest,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  wait = (delayMs) =>
    new Promise((resolve) => {
      setTimeout(resolve, delayMs);
    }),
} = {}) {
  if (activeVerification) return activeVerification;
  if (verificationState.status === "works") {
    return Promise.resolve(verificationState);
  }

  const startedAt = new Date().toISOString();
  verificationState = Object.freeze({
    ...initialState(),
    status: "running",
    startedAt,
  });

  activeVerification = (async () => {
    let lastError = null;
    const delays = Array.isArray(retryDelaysMs)
      ? retryDelaysMs.slice(0, 5)
      : DEFAULT_RETRY_DELAYS_MS;

    for (let index = 0; index < delays.length; index += 1) {
      const delayMs = Math.max(0, Number(delays[index]) || 0);
      if (delayMs > 0) await wait(delayMs);
      const attempts = index + 1;
      verificationState = Object.freeze({
        ...verificationState,
        status: "running",
        attempts,
      });

      try {
        const report = await runAcceptanceTest({
          ownerId,
          verifyDeleteGuard,
        });
        verificationState = publicReport("works", report, attempts);
        return verificationState;
      } catch (error) {
        lastError = error;
        if (index === delays.length - 1) {
          verificationState = publicReport(
            "failed",
            error?.report,
            attempts,
            typeof error?.code === "string"
              ? error.code
              : "MEMORY_ACCEPTANCE_FAILED",
          );
          return verificationState;
        }
      }
    }

    verificationState = publicReport(
      "failed",
      lastError?.report,
      0,
      "MEMORY_ACCEPTANCE_FAILED",
    );
    return verificationState;
  })().finally(() => {
    activeVerification = null;
  });

  return activeVerification;
}
