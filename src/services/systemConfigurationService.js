import { getEnvironmentCatalog } from "../config/environmentCatalog.js";
import { getGoogleCloudRuntimeStatus } from "./googleCloudService.js";
import {
  getUserAuthConfigurationStatus,
  getUserAuthProvider,
  isTesterRegistrationEnabled,
} from "./userAuthService.js";

const DEFAULT_PRODUCTION_URL = "https://cloudaicore.com/health/ready";

function isConfigured(env, key) {
  return typeof env[key] === "string" && env[key].trim().length > 0;
}

function statusFor(
  item,
  runtimeConfigured,
  protectedFallback,
  requiredForSelectedAuth,
) {
  if (item.state === "unused") return "unused";
  if (item.state === "compatibility" && !requiredForSelectedAuth) {
    return runtimeConfigured ? "compatibility" : "not-needed";
  }
  if (runtimeConfigured) return "configured";
  if (protectedFallback) return "protected-fallback";
  if (item.managed || item.hasDefault) return "defaulted";
  if (item.requiredNow || requiredForSelectedAuth) return "missing-required";
  return "optional-missing";
}

export function buildEnvironmentInventory({
  env = process.env,
} = {}) {
  const authProvider = getUserAuthProvider(env);
  const requiredAuthKeys = new Set(
    authProvider === "identity-platform"
      ? [
          "IDENTITY_PLATFORM_PROJECT_ID",
          "IDENTITY_PLATFORM_API_KEY",
          "USER_SESSION_ENCRYPTION_KEY",
        ]
      : [
          "SUPABASE_URL",
          "SUPABASE_PUBLISHABLE_KEY",
          "SUPABASE_SESSION_ENCRYPTION_KEY",
        ],
  );
  const protectedFallbacks = new Set();
  if (
    authProvider === "identity-platform" &&
    !isConfigured(env, "IDENTITY_PLATFORM_PROJECT_ID") &&
    (isConfigured(env, "GOOGLE_CLOUD_PROJECT") ||
      isConfigured(env, "GCLOUD_PROJECT") ||
      isConfigured(env, "GCP_PROJECT_ID"))
  ) {
    protectedFallbacks.add("IDENTITY_PLATFORM_PROJECT_ID");
  }
  if (getUserAuthConfigurationStatus(env).sessionProtection) {
    protectedFallbacks.add("SUPABASE_SESSION_ENCRYPTION_KEY");
    protectedFallbacks.add("USER_SESSION_ENCRYPTION_KEY");
  }
  if (isTesterRegistrationEnabled(env)) {
    protectedFallbacks.add("SYNCHRON_TEST_INVITE_CODE");
  }
  return getEnvironmentCatalog().map((item) => {
    const runtimeConfigured = isConfigured(env, item.key);
    const protectedFallback =
      Boolean(item.hasProtectedFallback) && protectedFallbacks.has(item.key);
    return Object.freeze({
      key: item.key,
      area: item.area,
      purpose: item.purpose,
      sensitivity: item.sensitivity,
      state: item.state,
      requiredNow: Boolean(item.requiredNow),
      runtimeConfigured,
      protectedFallback,
      source: runtimeConfigured
        ? "google-cloud-runtime"
        : protectedFallback
          ? "protected-runtime-fallback"
          : item.managed || item.hasDefault
            ? "application-default"
            : null,
      status: statusFor(
        item,
        runtimeConfigured,
        protectedFallback,
        requiredAuthKeys.has(item.key),
      ),
    });
  });
}

function summarize(items) {
  const count = (status) =>
    items.filter((item) => item.status === status).length;
  return {
    total: items.length,
    configured: count("configured"),
    defaulted: count("defaulted"),
    protectedFallback: count("protected-fallback"),
    missingRequired: count("missing-required"),
    optionalMissing: count("optional-missing"),
    compatibility: count("compatibility"),
    unused: count("unused"),
  };
}

function cleanCommit(value) {
  const commit = typeof value === "string" ? value.trim() : "";
  return /^[a-f0-9]{7,64}$/iu.test(commit) ? commit : null;
}

function emptyProductionStatus(errorCode = "PRODUCTION_READINESS_UNAVAILABLE") {
  return {
    connected: false,
    status: "unavailable",
    commit: null,
    memoryAcceptance: null,
    errorCode,
  };
}

export async function getProductionReadinessStatus({
  fetchImpl = globalThis.fetch,
  url = DEFAULT_PRODUCTION_URL,
  timeoutMs = 3_000,
} = {}) {
  if (typeof fetchImpl !== "function") {
    return emptyProductionStatus("PRODUCTION_FETCH_UNAVAILABLE");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      cache: "no-store",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    const body = await response.json();
    const commit = cleanCommit(body?.commit);
    if (!response.ok || body?.status !== "ready" || !commit) {
      return emptyProductionStatus("PRODUCTION_NOT_READY");
    }
    const acceptance = body?.checks?.memoryAcceptance;
    return {
      connected: true,
      status: "ready",
      commit,
      memoryAcceptance: acceptance
        ? {
            ready: acceptance.ready === true,
            status:
              typeof acceptance.status === "string"
                ? acceptance.status
                : "unknown",
            isolated: acceptance.isolated === true,
            realMemoryUnchanged: acceptance.realMemoryUnchanged === true,
            cleanupCompleted: acceptance.cleanupCompleted === true,
            passedSteps: Number.isInteger(acceptance.passedSteps)
              ? acceptance.passedSteps
              : 0,
          }
        : null,
      errorCode: null,
    };
  } catch {
    return emptyProductionStatus();
  } finally {
    clearTimeout(timer);
  }
}

export async function getSystemConfigurationReport({
  env = process.env,
  getGoogleCloudStatus = getGoogleCloudRuntimeStatus,
  getProductionStatus = getProductionReadinessStatus,
} = {}) {
  let googleCloud;
  try {
    googleCloud = await getGoogleCloudStatus({ env });
  } catch {
    googleCloud = {
      provider: "google-cloud",
      status: "unavailable",
      configured: false,
      cloudRunDetected: false,
      errorCode: "GOOGLE_CLOUD_RUNTIME_UNAVAILABLE",
    };
  }

  let production = emptyProductionStatus();
  try {
    production = await getProductionStatus();
  } catch {
    production = emptyProductionStatus();
  }

  const environment = buildEnvironmentInventory({ env });
  return {
    status:
      summarize(environment).missingRequired === 0 ? "ready" : "attention",
    secretsExposed: false,
    summary: summarize(environment),
    environment,
    googleCloud,
    production,
  };
}

export function formatSystemConfigurationReport(report) {
  const missing = report.environment.filter(
    (item) => item.status === "missing-required",
  );
  const compatibility = report.environment.filter(
    (item) => item.status === "compatibility",
  );
  const unused = report.environment.filter((item) => item.status === "unused");
  const protectedFallbacks = report.environment.filter(
    (item) => item.status === "protected-fallback",
  );
  const productionReady = report.production?.status === "ready";
  const memoryAcceptance = report.production?.memoryAcceptance;
  return [
    "Проверих системната конфигурация без да показвам стойности.",
    `• ${report.summary.configured} настройки са налични в runtime.`,
    `• ${report.summary.defaulted} използват безопасна стойност по подразбиране.`,
    `• ${protectedFallbacks.length} използват работещ защитен заместител.`,
    `• ${missing.length} задължителни настройки липсват.`,
    `• Google Cloud runtime: ${report.googleCloud?.cloudRunDetected ? "Cloud Run е потвърден" : report.googleCloud?.configured ? "проектът е конфигуриран, но Cloud Run не е потвърден" : "не е конфигуриран"}.`,
    productionReady
      ? `• Production /health/ready: готово; commit ${report.production.commit}.`
      : "• Production /health/ready: не е потвърдено.",
    ...(memoryAcceptance?.ready
      ? [
          `• Постоянна памет: приемателният тест работи; ${memoryAcceptance.passedSteps} проверени стъпки; изолиран=${memoryAcceptance.isolated ? "да" : "не"}; реалната памет е непроменена=${memoryAcceptance.realMemoryUnchanged ? "да" : "не"}.`,
        ]
      : []),
    ...(missing.length
      ? [`Липсват: ${missing.map((item) => item.key).join(", ")}.`]
      : []),
    ...(compatibility.length
      ? [
          `Стари резервни настройки: ${compatibility.map((item) => item.key).join(", ")}.`,
        ]
      : []),
    ...(protectedFallbacks.length
      ? [
          `Защитени заместители: ${protectedFallbacks.map((item) => item.key).join(", ")}. Те работят и не са блокер.`,
        ]
      : []),
    ...(unused.length
      ? [
          `Неизползвани настройки: ${unused.map((item) => item.key).join(", ")}.`,
        ]
      : []),
    "Стойности на ключове, пароли и token-и не се връщат.",
  ].join("\n");
}
