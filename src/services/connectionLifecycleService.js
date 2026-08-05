import { safeErrorCode, safeErrorMetadata } from "../utils/safeLogging.js";

const DEFAULT_OPTIONS = Object.freeze({
  timeoutMs: 1_000,
  maxRetries: 4,
  baseDelayMs: 250,
  maxDelayMs: 5_000,
  jitterRatio: 0.2,
  cooldownMs: 10_000,
});

function computeDelay(attempt, options, random = Math.random) {
  const exponential = Math.min(
    options.maxDelayMs,
    options.baseDelayMs * 2 ** Math.max(0, attempt - 1),
  );
  const jitterWindow = Math.round(exponential * options.jitterRatio);
  const jitter = jitterWindow > 0 ? Math.round((random() * 2 - 1) * jitterWindow) : 0;
  return Math.max(0, exponential + jitter);
}

async function withAbortableTimeout(run, timeoutMs, { signal } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), timeoutMs);
  const onAbort = () => controller.abort("cancelled");
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timeout);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

export function createConnectionLifecycleManager({
  name,
  connect,
  keepalive,
  now = () => Date.now(),
  wait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  random = Math.random,
  logger = () => {},
  options = {},
} = {}) {
  const settings = Object.freeze({ ...DEFAULT_OPTIONS, ...options });
  let state = {
    phase: "idle",
    ready: false,
    attempt: 0,
    retriesRemaining: settings.maxRetries,
    nextDelayMs: 0,
    cooldownUntil: 0,
    lastErrorCode: null,
    lastEventAt: null,
  };
  let activePromise = null;
  let currentAbortController = null;

  function emit(event, extra = {}) {
    state = Object.freeze({
      ...state,
      lastEventAt: now(),
      ...extra.state,
    });
    logger(event, {
      connection: name,
      phase: state.phase,
      ready: state.ready,
      attempt: state.attempt,
      retriesRemaining: state.retriesRemaining,
      nextDelayMs: state.nextDelayMs,
      cooldownUntil: state.cooldownUntil || null,
      error: extra.error || null,
    });
  }

  async function open({ signal } = {}) {
    const cooldownRemaining = state.cooldownUntil - now();
    if (cooldownRemaining > 0) {
      emit("connection.cooldown", {
        state: { phase: "cooldown", ready: false, nextDelayMs: cooldownRemaining },
      });
      return state;
    }
    if (activePromise) return activePromise;

    activePromise = (async () => {
      emit("connection.init", { state: { phase: "init", ready: false } });
      for (let attempt = 1; attempt <= settings.maxRetries + 1; attempt += 1) {
        currentAbortController = new AbortController();
        const mergedSignal = signal || currentAbortController.signal;
        emit("connection.connect", {
          state: {
            phase: "connect",
            ready: false,
            attempt,
            retriesRemaining: settings.maxRetries + 1 - attempt,
            nextDelayMs: 0,
          },
        });
        try {
          const result = await withAbortableTimeout(
            (timeoutSignal) =>
              connect({
                signal: timeoutSignal,
                attempt,
                keepalive,
              }),
            settings.timeoutMs,
            { signal: mergedSignal },
          );
          emit("connection.ready", {
            state: {
              phase: "ready",
              ready: true,
              attempt,
              retriesRemaining: settings.maxRetries + 1 - attempt,
              nextDelayMs: 0,
              cooldownUntil: 0,
              lastErrorCode: null,
            },
          });
          return { ok: true, result, state };
        } catch (error) {
          const aborted =
            error?.name === "AbortError" ||
            currentAbortController.signal.aborted ||
            signal?.aborted;
          const errorCode = aborted
            ? "CONNECTION_ABORTED"
            : safeErrorCode(error, "CONNECTION_FAILED");
          const isLastAttempt = attempt > settings.maxRetries;
          if (aborted) {
            emit("connection.disconnect", {
              state: {
                phase: "aborted",
                ready: false,
                attempt,
                lastErrorCode: errorCode,
              },
              error: safeErrorMetadata(error),
            });
            throw error;
          }
          if (isLastAttempt) {
            const cooldownUntil = now() + settings.cooldownMs;
            emit("connection.error", {
              state: {
                phase: "cooldown",
                ready: false,
                attempt,
                retriesRemaining: 0,
                nextDelayMs: settings.cooldownMs,
                cooldownUntil,
                lastErrorCode: errorCode,
              },
              error: safeErrorMetadata(error),
            });
            return { ok: false, state };
          }
          const nextDelayMs = computeDelay(attempt, settings, random);
          emit("connection.retry", {
            state: {
              phase: "retry-wait",
              ready: false,
              attempt,
              retriesRemaining: settings.maxRetries + 1 - attempt,
              nextDelayMs,
              lastErrorCode: errorCode,
            },
            error: safeErrorMetadata(error),
          });
          await wait(nextDelayMs);
        }
      }
      return { ok: false, state };
    })().finally(() => {
      activePromise = null;
      currentAbortController = null;
    });

    return activePromise;
  }

  function abort(reason = "manual-abort") {
    currentAbortController?.abort(reason);
  }

  function getStatus() {
    return state;
  }

  return Object.freeze({
    open,
    abort,
    getStatus,
  });
}

export function calculateRetryDelay(attempt, options = {}, random = () => 0.5) {
  return computeDelay(attempt, { ...DEFAULT_OPTIONS, ...options }, random);
}
