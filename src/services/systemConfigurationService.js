import { getEnvironmentCatalog } from "../config/environmentCatalog.js";
import { getDigitalOceanAppStatus } from "./digitalOceanService.js";
import {
  getUserAuthConfigurationStatus,
  isTesterRegistrationEnabled,
} from "./userAuthService.js";

const DEFAULT_PRODUCTION_URL = "https://synchron.foundation/health/ready";

function isConfigured(env, key) {
  return typeof env[key] === "string" && env[key].trim().length > 0;
}

function statusFor(
  item,
  runtimeConfigured,
  digitalOceanDeclared,
  protectedFallback,
) {
  if (item.state === "unused") return "unused";
  if (item.state === "compatibility") {
    return runtimeConfigured || digitalOceanDeclared
      ? "compatibility"
      : "not-needed";
  }
  if (runtimeConfigured) return "configured";
  if (protectedFallback) return "protected-fallback";
  if (item.managed || item.hasDefault) return "defaulted";
  if (item.requiredNow) return "missing-required";
  return "optional-missing";
}

export function buildEnvironmentInventory({
  env = process.env,
  digitalOceanVariables = [],
} = {}) {
  const protectedFallbacks = new Set();
  if (getUserAuthConfigurationStatus(env).sessionProtection) {
    protectedFallbacks.add("SUPABASE_SESSION_ENCRYPTION_KEY");
  }
  if (isTesterRegistrationEnabled(env)) {
    protectedFallbacks.add("SYNCHRON_TEST_INVITE_CODE");
  }
  const declared = new Map(
    digitalOceanVariables.map((item) => [item.key, item]),
  );
  return getEnvironmentCatalog().map((item) => {
    const platform = declared.get(item.key);
    const runtimeConfigured = isConfigured(env, item.key);
    const digitalOceanDeclared = Boolean(platform);
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
      digitalOceanDeclared,
      digitalOceanType: platform?.type || null,
      digitalOceanScope: platform?.scope || null,
      status: statusFor(
        item,
        runtimeConfigured,
        digitalOceanDeclared,
        protectedFallback,
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
  getDigitalOceanStatus = getDigitalOceanAppStatus,
  getProductionStatus = getProductionReadinessStatus,
} = {}) {
  let digitalOcean = {
    connected: false,
    errorCode: "DIGITALOCEAN_NOT_CONFIGURED",
    app: null,
    variables: [],
  };
  try {
    const status = await getDigitalOceanStatus({ env });
    digitalOcean = {
      connected: true,
      errorCode: null,
      app: {
        id: status.id,
        name: status.name,
        liveUrl: status.liveUrl,
        activeDeployment: status.activeDeployment,
        inProgressDeployment: status.inProgressDeployment,
      },
      variables: status.environmentVariables || [],
    };
  } catch (error) {
    digitalOcean.errorCode = error?.code || "DIGITALOCEAN_UNAVAILABLE";
  }

  let production = emptyProductionStatus();
  try {
    production = await getProductionStatus();
  } catch {
    production = emptyProductionStatus();
  }

  const environment = buildEnvironmentInventory({
    env,
    digitalOceanVariables: digitalOcean.variables,
  });
  return {
    status:
      summarize(environment).missingRequired === 0 ? "ready" : "attention",
    secretsExposed: false,
    summary: summarize(environment),
    environment,
    digitalOcean,
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
    `• DigitalOcean самопроверка: ${report.digitalOcean.connected ? "работи" : "не е достъпна"}.`,
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
