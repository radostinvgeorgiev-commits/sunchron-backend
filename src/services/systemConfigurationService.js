import { getEnvironmentCatalog } from "../config/environmentCatalog.js";
import { getDigitalOceanAppStatus } from "./digitalOceanService.js";

function isConfigured(env, key) {
  return typeof env[key] === "string" && env[key].trim().length > 0;
}

function statusFor(item, runtimeConfigured, digitalOceanDeclared) {
  if (item.state === "unused") return "unused";
  if (item.state === "compatibility") {
    return runtimeConfigured || digitalOceanDeclared
      ? "compatibility"
      : "not-needed";
  }
  if (runtimeConfigured) return "configured";
  if (item.managed || item.hasDefault) return "defaulted";
  if (item.requiredNow) return "missing-required";
  return "optional-missing";
}

export function buildEnvironmentInventory({
  env = process.env,
  digitalOceanVariables = [],
} = {}) {
  const declared = new Map(
    digitalOceanVariables.map((item) => [item.key, item]),
  );
  return getEnvironmentCatalog().map((item) => {
    const platform = declared.get(item.key);
    const runtimeConfigured = isConfigured(env, item.key);
    const digitalOceanDeclared = Boolean(platform);
    return Object.freeze({
      key: item.key,
      area: item.area,
      purpose: item.purpose,
      sensitivity: item.sensitivity,
      state: item.state,
      requiredNow: Boolean(item.requiredNow),
      runtimeConfigured,
      digitalOceanDeclared,
      digitalOceanType: platform?.type || null,
      digitalOceanScope: platform?.scope || null,
      status: statusFor(item, runtimeConfigured, digitalOceanDeclared),
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
    missingRequired: count("missing-required"),
    optionalMissing: count("optional-missing"),
    compatibility: count("compatibility"),
    unused: count("unused"),
  };
}

export async function getSystemConfigurationReport({
  env = process.env,
  getDigitalOceanStatus = getDigitalOceanAppStatus,
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
  return [
    "Проверих системната конфигурация без да показвам стойности.",
    `• ${report.summary.configured} настройки са налични в runtime.`,
    `• ${report.summary.defaulted} използват безопасна стойност по подразбиране.`,
    `• ${missing.length} задължителни настройки липсват.`,
    `• DigitalOcean самопроверка: ${report.digitalOcean.connected ? "работи" : "не е достъпна"}.`,
    ...(missing.length
      ? [`Липсват: ${missing.map((item) => item.key).join(", ")}.`]
      : []),
    ...(compatibility.length
      ? [
          `Стари резервни настройки: ${compatibility.map((item) => item.key).join(", ")}.`,
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
