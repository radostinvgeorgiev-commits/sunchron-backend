import {
  resolveFirestoreDatabaseId,
  resolveFirestoreProjectId,
  resolveMemoryBackend,
  resolvePersistenceBackend,
} from "../config/memoryBackend.js";
import { getUserAuthProvider } from "./userAuthService.js";

export const AI_CORE_PUBLIC_ORIGIN = "https://cloudaicore.com";
export const GOOGLE_CLOUD_CONSOLE_ORIGIN = "https://console.cloud.google.com";

function cleanRuntimeValue(value, maxLength = 180) {
  const clean = typeof value === "string" ? value.trim() : "";
  return clean && clean.length <= maxLength ? clean : null;
}

function cloudConsoleUrl(projectId) {
  const suffix = projectId ? `?project=${encodeURIComponent(projectId)}` : "";
  return `${GOOGLE_CLOUD_CONSOLE_ORIGIN}/run${suffix}`;
}

export function getGoogleCloudRuntimeStatus({ env = process.env } = {}) {
  const projectId = cleanRuntimeValue(resolveFirestoreProjectId(env));
  const service = cleanRuntimeValue(
    env.K_SERVICE || env.CLOUD_RUN_SERVICE || env.GCP_CLOUD_RUN_SERVICE,
  );
  const revision = cleanRuntimeValue(env.K_REVISION);
  const configuration = cleanRuntimeValue(env.K_CONFIGURATION);
  const region = cleanRuntimeValue(
    env.GOOGLE_CLOUD_REGION || env.GCP_REGION || env.CLOUD_RUN_REGION,
  );
  const commit = cleanRuntimeValue(env.APP_COMMIT_SHA, 64);
  const cloudRunDetected = Boolean(env.K_SERVICE && env.K_REVISION);
  const configured = Boolean(projectId);
  const memoryBackend = resolveMemoryBackend(env);
  const persistenceBackend = resolvePersistenceBackend(env);
  const authBackend = getUserAuthProvider(env);

  return Object.freeze({
    provider: "google-cloud",
    status: cloudRunDetected && configured ? "running" : configured ? "configured" : "unavailable",
    configured,
    cloudRunDetected,
    projectId,
    service,
    revision,
    configuration,
    region,
    commit,
    canonicalOrigin: AI_CORE_PUBLIC_ORIGIN,
    consoleUrl: cloudConsoleUrl(projectId),
    memoryBackend: memoryBackend === "firestore" ? memoryBackend : null,
    persistenceBackend:
      persistenceBackend === "firestore" ? persistenceBackend : null,
    firestoreDatabaseId: resolveFirestoreDatabaseId(env),
    authBackend: authBackend === "identity-platform" ? authBackend : null,
  });
}

export function formatGoogleCloudRuntimeStatus(status) {
  const running = status.cloudRunDetected === true;
  return [
    "Проверих активния Google Cloud runtime на AI CORE.",
    `• Каноничен сайт: ${status.canonicalOrigin}.`,
    `• Google Cloud project: ${status.projectId || "не е конфигуриран"}.`,
    `• Cloud Run: ${running ? "потвърден от runtime средата" : "не е потвърден от runtime средата"}.`,
    ...(status.service ? [`• Service: ${status.service}.`] : []),
    ...(status.revision ? [`• Revision: ${status.revision}.`] : []),
    ...(status.region ? [`• Region: ${status.region}.`] : []),
    ...(status.commit ? [`• Commit: ${status.commit}.`] : []),
    `• Памет: ${status.memoryBackend || "невалидна конфигурация"}; постоянни данни: ${status.persistenceBackend || "невалидна конфигурация"}.`,
    `• Потребители: ${status.authBackend}.`,
    "Не са четени или показвани стойности на secrets.",
  ].join("\n");
}
