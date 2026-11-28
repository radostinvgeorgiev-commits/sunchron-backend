import { probeAiProviders } from "./aiProviderProbeService.js";
import { getGoogleCloudRuntimeStatus } from "./googleCloudService.js";
import { getSystemConfigurationReport } from "./systemConfigurationService.js";
import { listTasks } from "./taskManagementService.js";
import { getReadinessStatus } from "../routes/health.js";

// Real, read-only checks for the tools that have no Google or GitHub call of
// their own, so „Работи“ in the tools list means something answered just
// now. AI providers use the cached tiny probe (one request per provider every
// ten minutes at most); nothing here writes or spends beyond that.

const TIMEOUT_MS = 12_000;

function withTimeout(promise) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function settle(run) {
  try {
    return { value: await withTimeout(Promise.resolve().then(run)) };
  } catch {
    return { failed: true };
  }
}

const ok = () => ({ ok: true });
const fail = (reason) => ({ ok: false, reason });

export async function checkCoreTools(
  { ownerId = "" } = {},
  {
    probe = () => probeAiProviders(),
    readiness = () => getReadinessStatus(),
    systemReport = () => getSystemConfigurationReport(),
    cloudStatus = () => getGoogleCloudRuntimeStatus(),
    tasks = (owner) => listTasks({ ownerId: owner, limit: 1 }),
  } = {},
) {
  const [probes, ready, report, cloud, taskList] = await Promise.all([
    settle(probe),
    settle(readiness),
    settle(systemReport),
    settle(cloudStatus),
    settle(() => tasks(ownerId)),
  ]);
  const providers = Array.isArray(probes.value) ? probes.value : [];
  const provider = (id, name) => {
    const found = providers.find((item) => item.id === id);
    if (found?.working) return ok();
    if (probes.failed || !found) return fail(`${name} не отговори.`);
    return fail(`${name}: ${found.reason || "не отговаря"}.`);
  };
  const anyChat = providers.some((item) => item.working)
    ? ok()
    : fail("Нито един AI модел не отговори.");
  const reportOk =
    !report.failed && report.value && report.value.summary?.missingRequired === 0
      ? ok()
      : fail("Системният преглед не мина.");
  const cloudOk =
    !cloud.failed && cloud.value?.status === "running"
      ? ok()
      : fail("Google Cloud не отговори.");
  const memoryOk = ready.value?.checks?.memory?.ready
    ? ok()
    : fail("Паметта не отговори.");
  return {
    "synchron-agent-chat": anyChat,
    "synchron-integrations-status": reportOk,
    "synchron-system-inspector": reportOk,
    "openai-codex": provider("vertex-gemini", "Vertex Gemini"),
    "openai-web-search": provider("vertex-gemini", "Vertex Gemini"),
    "gemini-youtube": provider("gemini", "Gemini"),
    "gemini-maps": provider("gemini", "Gemini"),
    images: provider("vertex-gemini", "Vertex Gemini"),
    "google-cloud-read": cloudOk,
    "google-cloud-diagnostics": cloudOk,
    "google-cloud-write": cloudOk,
    "google-firestore-memory": memoryOk,
    "synchron-tasks": taskList.failed ? fail("Задачите не се прочетоха.") : ok(),
  };
}
