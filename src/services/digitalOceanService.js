import { randomBytes } from "node:crypto";

const DEFAULT_API_URL = "https://api.digitalocean.com/v2";
const DEFAULT_APP_NAME = "sunchron-backend";
const PRIMARY_PUBLIC_DOMAIN = "synchron.foundation";
export const PUBLIC_WWW_DOMAIN = "www.synchron.foundation";
export const TESTER_AUTH_ENV_KEYS = Object.freeze([
  "SUPABASE_URL",
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SESSION_ENCRYPTION_KEY",
  "SYNCHRON_TEST_INVITE_CODE",
]);

export class DigitalOceanError extends Error {
  constructor(message, status = 502, code = "DIGITALOCEAN_ERROR") {
    super(message);
    this.name = "DigitalOceanError";
    this.status = status;
    this.code = code;
  }
}

function safeUpstreamMessage(payload) {
  const message =
    typeof payload?.message === "string" ? payload.message.trim() : "";
  if (!message) return "";
  return message
    .replace(/\b(?:dop|doo|dor)_v1_[A-Za-z0-9_-]+\b/gu, "[скрит токен]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]+\b/giu, "Bearer [скрит токен]")
    .slice(0, 300);
}

async function readErrorPayload(response) {
  try {
    const payload = await response.json();
    return payload && typeof payload === "object" ? payload : {};
  } catch {
    return {};
  }
}

function digitalOceanRequestError(response, payload, { method, path }) {
  const upstreamMessage = safeUpstreamMessage(payload);
  const suffix = upstreamMessage ? ` DigitalOcean: ${upstreamMessage}` : "";

  if (response.status === 401) {
    return new DigitalOceanError(
      `DigitalOcean токенът е невалиден, изтекъл или е отнет.${suffix}`,
      401,
      "DIGITALOCEAN_TOKEN_INVALID",
    );
  }
  if (
    response.status === 403 &&
    method === "PUT" &&
    /^\/apps\/[^/]+$/u.test(path)
  ) {
    return new DigitalOceanError(
      `DigitalOcean токенът няма право да променя App Platform. Нужно е разрешение app:update заедно с app:read.${suffix}`,
      403,
      "DIGITALOCEAN_APP_UPDATE_FORBIDDEN",
    );
  }
  if (response.status === 403) {
    return new DigitalOceanError(
      `DigitalOcean токенът няма право за това действие.${suffix}`,
      403,
      "DIGITALOCEAN_FORBIDDEN",
    );
  }
  if (response.status === 422) {
    return new DigitalOceanError(
      `DigitalOcean отхвърли настройките на приложението.${suffix}`,
      422,
      "DIGITALOCEAN_APP_SPEC_REJECTED",
    );
  }
  return new DigitalOceanError(
    `DigitalOcean API върна грешка ${response.status}.${suffix}`,
    response.status >= 400 && response.status < 500 ? response.status : 502,
    "DIGITALOCEAN_UPSTREAM_ERROR",
  );
}

function requiredToken(env = process.env) {
  const token = env.DIGITALOCEAN_API_TOKEN || env.DIGITALOCEAN_TOKEN;
  if (!token) {
    throw new DigitalOceanError(
      "DigitalOcean мостът не е конфигуриран. Нужен е DIGITALOCEAN_API_TOKEN.",
      503,
      "DIGITALOCEAN_NOT_CONFIGURED",
    );
  }
  return token;
}

function requiredAppConfig(env = process.env) {
  const token = requiredToken(env);
  const appId = env.DIGITALOCEAN_APP_ID;
  if (!appId) {
    throw new DigitalOceanError(
      "Липсва DIGITALOCEAN_APP_ID за проверката на приложението.",
      503,
      "DIGITALOCEAN_APP_NOT_CONFIGURED",
    );
  }
  return { token, appId };
}

async function request(
  path,
  {
    env = process.env,
    fetchImpl = fetch,
    method = "GET",
    body = undefined,
  } = {},
) {
  const token = requiredToken(env);
  let response;
  try {
    response = await fetchImpl(
      `${env.DIGITALOCEAN_API_URL || DEFAULT_API_URL}${path}`,
      {
        method,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          ...(body === undefined
            ? {}
            : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
  } catch {
    throw new DigitalOceanError(
      "DigitalOcean API временно не е достъпен. Опитай отново след малко.",
      502,
      "DIGITALOCEAN_NETWORK_ERROR",
    );
  }
  if (!response.ok) {
    const payload = await readErrorPayload(response);
    throw digitalOceanRequestError(response, payload, { method, path });
  }
  return response.json();
}

function normalizeTesterAuthConfig({ projectUrl, publishableKey }) {
  let url;
  try {
    url = new URL(String(projectUrl || "").trim());
  } catch {
    throw new DigitalOceanError(
      "Supabase project URL е невалиден.",
      400,
      "TESTER_AUTH_INVALID_SUPABASE_URL",
    );
  }
  if (
    url.protocol !== "https:" ||
    !/^[a-z0-9]+\.supabase\.co$/u.test(url.hostname) ||
    url.pathname !== "/"
  ) {
    throw new DigitalOceanError(
      "Supabase project URL трябва да е защитен адрес на Supabase.",
      400,
      "TESTER_AUTH_INVALID_SUPABASE_URL",
    );
  }

  const key = String(publishableKey || "").trim();
  if (!/^sb_publishable_[A-Za-z0-9_-]{20,}$/u.test(key)) {
    throw new DigitalOceanError(
      "Supabase publishable key е невалиден.",
      400,
      "TESTER_AUTH_INVALID_PUBLISHABLE_KEY",
    );
  }
  return { projectUrl: url.origin, publishableKey: key };
}

function assertSafeSecretRoundTrip(spec) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    throw new DigitalOceanError(
      "DigitalOcean не върна валиден app spec.",
      502,
      "DIGITALOCEAN_INVALID_APP_SPEC",
    );
  }
  const unsafe = listDigitalOceanEnvironmentVariables(spec).filter(
    ({ type, sourceKind, sourceName, key }) => {
      if (type !== "SECRET") return false;
      const sources =
        sourceKind === "app"
          ? [spec]
          : {
              service: spec.services,
              worker: spec.workers,
              job: spec.jobs,
              function: spec.functions,
              "static-site": spec.static_sites,
            }[sourceKind] || [];
      const source =
        sourceKind === "app"
          ? spec
          : sources.find((item) => (item?.name || sourceKind) === sourceName);
      const value = source?.envs?.find((item) => item?.key === key)?.value;
      return typeof value !== "string" || value.length === 0;
    },
  );
  if (unsafe.length) {
    throw new DigitalOceanError(
      "DigitalOcean не върна безопасно съществуващите encrypted variables. App spec няма да бъде променен.",
      409,
      "DIGITALOCEAN_SECRET_ROUND_TRIP_UNSAFE",
    );
  }
}

function normalizeDomainName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\.$/u, "");
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
    String(value || "").trim(),
  );
}

function appMatchesPublicProject(app, configuredValue) {
  const appName = String(app?.spec?.name || app?.name || "").trim();
  const acceptedNames = new Set(
    [configuredValue, DEFAULT_APP_NAME]
      .map((value) => String(value || "").trim())
      .filter(Boolean),
  );
  const domains = listDigitalOceanDomains(app?.spec);
  return (
    acceptedNames.has(appName) ||
    domains.some(({ domain }) =>
      [PRIMARY_PUBLIC_DOMAIN, PUBLIC_WWW_DOMAIN].includes(domain),
    )
  );
}

async function resolveDomainAppConfig({
  env = process.env,
  fetchImpl = fetch,
}) {
  const token = requiredToken(env);
  const configuredValue = String(env.DIGITALOCEAN_APP_ID || "").trim();
  if (isUuid(configuredValue)) {
    return { token, appId: configuredValue, resolvedFromList: false };
  }

  const options = { env: { ...env, DIGITALOCEAN_API_TOKEN: token }, fetchImpl };
  const appsData = await request("/apps?per_page=200", options);
  const matches = (Array.isArray(appsData.apps) ? appsData.apps : []).filter(
    (app) => isUuid(app?.id) && appMatchesPublicProject(app, configuredValue),
  );
  if (matches.length !== 1) {
    throw new DigitalOceanError(
      matches.length > 1
        ? "Намерени са повече от едно възможни DigitalOcean приложения. Няма да бъде направена промяна."
        : "Работещото DigitalOcean приложение не беше намерено автоматично. Няма да бъде направена промяна.",
      409,
      matches.length > 1
        ? "DIGITALOCEAN_APP_RESOLUTION_AMBIGUOUS"
        : "DIGITALOCEAN_APP_RESOLUTION_FAILED",
    );
  }
  return { token, appId: matches[0].id, resolvedFromList: true };
}

export function listDigitalOceanDomains(spec = {}) {
  return (Array.isArray(spec?.domains) ? spec.domains : [])
    .map((entry) => ({
      domain: normalizeDomainName(entry?.domain),
      type: typeof entry?.type === "string" ? entry.type : null,
    }))
    .filter(({ domain }) => domain);
}

export function addDigitalOceanDomainAlias(spec, domain = PUBLIC_WWW_DOMAIN) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    throw new DigitalOceanError(
      "DigitalOcean не върна валиден app spec.",
      502,
      "DIGITALOCEAN_INVALID_APP_SPEC",
    );
  }
  const normalizedDomain = normalizeDomainName(domain);
  if (normalizedDomain !== PUBLIC_WWW_DOMAIN) {
    throw new DigitalOceanError(
      "Разрешен е само публичният www адрес на AI CORE.",
      400,
      "DIGITALOCEAN_DOMAIN_NOT_ALLOWED",
    );
  }
  const currentDomains = listDigitalOceanDomains(spec);
  if (currentDomains.some((entry) => entry.domain === normalizedDomain)) {
    return { spec: structuredClone(spec), added: false };
  }
  const nextSpec = structuredClone(spec);
  nextSpec.domains = [
    ...(Array.isArray(nextSpec.domains) ? nextSpec.domains : []),
    { domain: normalizedDomain, type: "ALIAS" },
  ];
  return { spec: nextSpec, added: true };
}

async function loadDomainAliasActivation({
  domain = PUBLIC_WWW_DOMAIN,
  expectedAppId = "",
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const { token, appId } = await resolveDomainAppConfig({ env, fetchImpl });
  if (expectedAppId && expectedAppId !== appId) {
    throw new DigitalOceanError(
      "Потвърждението е за друго DigitalOcean приложение.",
      409,
      "DIGITALOCEAN_APP_CHANGED",
    );
  }
  const normalizedDomain = normalizeDomainName(domain);
  if (normalizedDomain !== PUBLIC_WWW_DOMAIN) {
    throw new DigitalOceanError(
      "Разрешен е само публичният www адрес на AI CORE.",
      400,
      "DIGITALOCEAN_DOMAIN_NOT_ALLOWED",
    );
  }
  const options = { env: { ...env, DIGITALOCEAN_API_TOKEN: token }, fetchImpl };
  const appData = await request(`/apps/${encodeURIComponent(appId)}`, options);
  const app = appData.app || {};
  const currentSpec = app.spec;
  assertSafeSecretRoundTrip(currentSpec);
  return {
    app,
    appId,
    currentSpec,
    currentDomains: listDigitalOceanDomains(currentSpec),
    domain: normalizedDomain,
    options,
  };
}

export async function inspectDigitalOceanDomainAlias(options = {}) {
  const inspection = await loadDomainAliasActivation(options);
  return {
    appId: inspection.appId,
    domain: inspection.domain,
    configured: inspection.currentDomains.some(
      (entry) => entry.domain === inspection.domain,
    ),
    currentDomains: inspection.currentDomains,
    readAccessVerified: true,
    requiredWriteScope: "app:update",
  };
}

export async function activateDigitalOceanDomainAlias({
  domain = PUBLIC_WWW_DOMAIN,
  expectedAppId = "",
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const inspection = await loadDomainAliasActivation({
    domain,
    expectedAppId,
    env,
    fetchImpl,
  });
  const update = addDigitalOceanDomainAlias(
    inspection.currentSpec,
    inspection.domain,
  );
  if (!update.added) {
    return {
      updated: false,
      appId: inspection.appId,
      domain: inspection.domain,
      deploymentId:
        inspection.app.in_progress_deployment?.id ||
        inspection.app.active_deployment?.id ||
        null,
    };
  }
  const updatedData = await request(
    `/apps/${encodeURIComponent(inspection.appId)}`,
    {
      ...inspection.options,
      method: "PUT",
      body: { spec: update.spec },
    },
  );
  return {
    updated: true,
    appId: inspection.appId,
    domain: inspection.domain,
    deploymentId:
      updatedData.app?.in_progress_deployment?.id ||
      updatedData.app?.active_deployment?.id ||
      null,
  };
}

export function missingTesterAuthEnvironmentKeys(spec = {}) {
  const existing = new Set(
    listDigitalOceanEnvironmentVariables(spec).map(({ key }) => key),
  );
  return TESTER_AUTH_ENV_KEYS.filter((key) => !existing.has(key));
}

export function addTesterAuthEnvironmentVariables(
  spec,
  { projectUrl, publishableKey, sessionEncryptionKey, inviteCode },
) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    throw new DigitalOceanError(
      "DigitalOcean не върна валиден app spec.",
      502,
      "DIGITALOCEAN_INVALID_APP_SPEC",
    );
  }
  const missingKeys = missingTesterAuthEnvironmentKeys(spec);
  const values = {
    SUPABASE_URL: projectUrl,
    SUPABASE_PUBLISHABLE_KEY: publishableKey,
    SUPABASE_SESSION_ENCRYPTION_KEY: sessionEncryptionKey,
    SYNCHRON_TEST_INVITE_CODE: inviteCode,
  };
  const nextSpec = structuredClone(spec);
  const current = Array.isArray(nextSpec.envs) ? nextSpec.envs : [];
  nextSpec.envs = [
    ...current,
    ...missingKeys.map((key) => ({
      key,
      scope: "RUN_TIME",
      type: "SECRET",
      value: values[key],
    })),
  ];
  return { spec: nextSpec, missingKeys };
}

async function loadTesterAuthActivation({
  projectUrl,
  publishableKey,
  expectedAppId = "",
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const { token, appId } = requiredAppConfig(env);
  if (expectedAppId && expectedAppId !== appId) {
    throw new DigitalOceanError(
      "Потвърждението е за друго DigitalOcean приложение.",
      409,
      "DIGITALOCEAN_APP_CHANGED",
    );
  }
  const config = normalizeTesterAuthConfig({ projectUrl, publishableKey });
  const options = { env: { ...env, DIGITALOCEAN_API_TOKEN: token }, fetchImpl };
  const appData = await request(`/apps/${encodeURIComponent(appId)}`, options);
  const app = appData.app || {};
  const currentSpec = app.spec;
  assertSafeSecretRoundTrip(currentSpec);
  return {
    app,
    appId,
    config,
    currentSpec,
    missingKeys: missingTesterAuthEnvironmentKeys(currentSpec),
    options,
  };
}

export async function inspectTesterAuthActivation(options = {}) {
  const inspection = await loadTesterAuthActivation(options);
  return {
    appId: inspection.appId,
    missingKeys: inspection.missingKeys,
    readAccessVerified: true,
    requiredWriteScope: "app:update",
    writeAccess:
      inspection.missingKeys.length === 0 ? "not-needed" : "verified-on-update",
  };
}

export async function activateTesterAuthConfiguration({
  projectUrl,
  publishableKey,
  expectedAppId = "",
  env = process.env,
  fetchImpl = fetch,
  randomBytesImpl = randomBytes,
} = {}) {
  const {
    app,
    appId,
    config,
    currentSpec,
    missingKeys: existingMissing,
    options,
  } = await loadTesterAuthActivation({
    projectUrl,
    publishableKey,
    expectedAppId,
    env,
    fetchImpl,
  });
  if (!existingMissing.length) {
    return {
      updated: false,
      appId,
      changedKeys: [],
      deploymentId: app.in_progress_deployment?.id || null,
      inviteCode: env.SYNCHRON_TEST_INVITE_CODE || null,
    };
  }

  const sessionEncryptionKey = randomBytesImpl(32).toString("base64url");
  const inviteCode = randomBytesImpl(12).toString("base64url");
  const update = addTesterAuthEnvironmentVariables(currentSpec, {
    ...config,
    sessionEncryptionKey,
    inviteCode,
  });
  const updatedData = await request(`/apps/${encodeURIComponent(appId)}`, {
    ...options,
    method: "PUT",
    body: { spec: update.spec },
  });
  return {
    updated: true,
    appId,
    changedKeys: update.missingKeys,
    deploymentId:
      updatedData.app?.in_progress_deployment?.id ||
      updatedData.app?.active_deployment?.id ||
      null,
    inviteCode: update.missingKeys.includes("SYNCHRON_TEST_INVITE_CODE")
      ? inviteCode
      : env.SYNCHRON_TEST_INVITE_CODE || null,
  };
}

export function listDigitalOceanEnvironmentVariables(spec = {}) {
  const components = [
    ["app", spec.name || "app", spec.envs],
    ...[
      ["service", spec.services],
      ["worker", spec.workers],
      ["job", spec.jobs],
      ["function", spec.functions],
      ["static-site", spec.static_sites],
    ].flatMap(([kind, items]) =>
      (Array.isArray(items) ? items : []).map((item) => [
        kind,
        item?.name || kind,
        item?.envs,
      ]),
    ),
  ];

  return components
    .flatMap(([sourceKind, sourceName, envs]) =>
      (Array.isArray(envs) ? envs : [])
        .filter((item) => typeof item?.key === "string" && item.key.trim())
        .map((item) => ({
          key: item.key.trim(),
          scope: item.scope || null,
          type: item.type || "GENERAL",
          sourceKind,
          sourceName,
        })),
    )
    .sort(
      (left, right) =>
        left.key.localeCompare(right.key) ||
        left.sourceKind.localeCompare(right.sourceKind) ||
        left.sourceName.localeCompare(right.sourceName),
    );
}

export async function getDigitalOceanAppStatus(options = {}) {
  const { appId } = requiredAppConfig(options.env);
  const [appData, deploymentsData] = await Promise.all([
    request(`/apps/${encodeURIComponent(appId)}`, options),
    request(
      `/apps/${encodeURIComponent(appId)}/deployments?page=1&per_page=5`,
      options,
    ),
  ]);
  const app = appData.app || {};
  const deployments = (deploymentsData.deployments || []).slice(0, 5);
  return {
    id: app.id || appId,
    name: app.spec?.name || app.name || "SYNCHRON-X",
    liveUrl: app.live_url || null,
    activeDeployment: app.active_deployment
      ? {
          id: app.active_deployment.id,
          phase: app.active_deployment.phase,
          createdAt: app.active_deployment.created_at,
          updatedAt: app.active_deployment.updated_at,
        }
      : null,
    inProgressDeployment: app.in_progress_deployment
      ? {
          id: app.in_progress_deployment.id,
          phase: app.in_progress_deployment.phase,
        }
      : null,
    environmentVariables: listDigitalOceanEnvironmentVariables(app.spec),
    deployments: deployments.map((deployment) => ({
      id: deployment.id,
      phase: deployment.phase,
      cause: deployment.cause,
      createdAt: deployment.created_at,
      updatedAt: deployment.updated_at,
    })),
  };
}

const AUDIT_RESOURCES = Object.freeze([
  ["account", "/account"],
  ["apps", "/apps?per_page=200"],
  ["droplets", "/droplets?per_page=200"],
  ["databases", "/databases?per_page=200"],
  ["volumes", "/volumes?per_page=200"],
  ["snapshots", "/snapshots?per_page=200"],
  ["vpcs", "/vpcs?per_page=200"],
  ["firewalls", "/firewalls?per_page=200"],
  ["domains", "/domains?per_page=200"],
  ["loadBalancers", "/load_balancers?per_page=200"],
  ["reservedIps", "/reserved_ips?per_page=200"],
  ["kubernetes", "/kubernetes/clusters?per_page=200"],
  ["certificates", "/certificates?per_page=200"],
  ["cdnEndpoints", "/cdn/endpoints?per_page=200"],
  ["functions", "/functions/namespaces?per_page=200"],
  ["customImages", "/images?private=true&per_page=200"],
  ["sshKeys", "/account/keys?per_page=200"],
  ["tags", "/tags?per_page=200"],
  ["uptimeChecks", "/uptime/checks?per_page=200"],
  ["registry", "/registry"],
  ["projects", "/projects?per_page=200"],
  ["actions", "/actions?per_page=50"],
  ["balance", "/customers/my/balance"],
]);

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function validIsoDate(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const stamp = Date.parse(value);
  return Number.isFinite(stamp) ? new Date(stamp).toISOString() : null;
}

export async function getDigitalOceanDatabaseBackupInventory(
  databases,
  options = {},
) {
  return Promise.all(
    safeArray(databases).map(async (database) => {
      const engine =
        typeof database?.engine === "string" ? database.engine : "unknown";
      if (typeof database?.id !== "string" || !database.id.trim()) {
        return {
          engine,
          status: "unverified",
          backupCount: null,
          oldestCreatedAt: null,
          newestCreatedAt: null,
          errorCode: "DATABASE_ID_MISSING",
          errorStatus: null,
        };
      }
      try {
        const data = await request(
          `/databases/${encodeURIComponent(database.id)}/backups?per_page=200`,
          options,
        );
        const dates = safeArray(data?.backups)
          .map((backup) => validIsoDate(backup?.created_at))
          .filter(Boolean)
          .sort();
        return {
          engine,
          status: "verified",
          backupCount: safeArray(data?.backups).length,
          oldestCreatedAt: dates[0] || null,
          newestCreatedAt: dates.at(-1) || null,
          errorCode: null,
          errorStatus: null,
        };
      } catch (error) {
        return {
          engine,
          status: "unverified",
          backupCount: null,
          oldestCreatedAt: null,
          newestCreatedAt: null,
          errorCode: error?.code || "DIGITALOCEAN_UPSTREAM_ERROR",
          errorStatus: error?.status || null,
        };
      }
    }),
  );
}

export async function getDigitalOceanOpenSearchBackupAudit(options = {}) {
  const data = await request("/databases?per_page=200", options);
  const databases = safeArray(data?.databases).filter(
    (database) => database?.engine === "opensearch",
  );
  return {
    checkedAt: new Date().toISOString(),
    databaseBackups: await getDigitalOceanDatabaseBackupInventory(
      databases,
      options,
    ),
  };
}

function regionSlug(resource) {
  return resource?.region?.slug || resource?.region || null;
}

function mapApp(app) {
  return {
    id: app.id,
    name: app.spec?.name || app.name || "неименувано приложение",
    region: app.region?.slug || app.region || app.spec?.region || null,
    tier: app.tier_slug || app.tier || null,
    liveUrl: app.live_url || null,
    activeDeploymentPhase: app.active_deployment?.phase || null,
    inProgressDeploymentPhase: app.in_progress_deployment?.phase || null,
  };
}

function mapDroplet(droplet) {
  return {
    id: droplet.id,
    name: droplet.name,
    status: droplet.status,
    region: regionSlug(droplet),
    size: droplet.size_slug || droplet.size?.slug || null,
    monthlyPrice: droplet.size?.price_monthly ?? null,
    backupsEnabled: safeArray(droplet.features).includes("backups"),
    locked: Boolean(droplet.locked),
    vpcAttached: Boolean(droplet.vpc_uuid),
  };
}

function mapDatabase(database) {
  return {
    id: database.id,
    name: database.name,
    status: database.status,
    engine: database.engine,
    version: database.version,
    region: database.region || null,
    size: database.size || null,
    nodeCount: database.num_nodes ?? null,
    privateNetworkAttached: Boolean(database.private_network_uuid),
  };
}

function mapVolume(volume) {
  return {
    id: volume.id,
    name: volume.name,
    sizeGigabytes: volume.size_gigabytes,
    region: regionSlug(volume),
    filesystemType: volume.filesystem_type || null,
    attachedDroplets: safeArray(volume.droplet_ids).length,
  };
}

function mapSnapshot(snapshot) {
  return {
    id: snapshot.id,
    name: snapshot.name,
    resourceType: snapshot.resource_type,
    sizeGigabytes: snapshot.size_gigabytes,
    regions: safeArray(snapshot.regions),
    createdAt: snapshot.created_at,
  };
}

function mapVpc(vpc) {
  return {
    id: vpc.id,
    name: vpc.name,
    region: vpc.region || null,
    isDefault: Boolean(vpc.default),
    createdAt: vpc.created_at,
  };
}

function mapFirewall(firewall) {
  return {
    id: firewall.id,
    name: firewall.name,
    status: firewall.status,
    attachedDroplets: safeArray(firewall.droplet_ids).length,
    tags: safeArray(firewall.tags),
    inboundRules: safeArray(firewall.inbound_rules).length,
    outboundRules: safeArray(firewall.outbound_rules).length,
  };
}

function mapDomain(domain) {
  return {
    name: domain.name,
    ttl: domain.ttl ?? null,
    zoneFileAvailable: Boolean(domain.zone_file),
  };
}

function mapLoadBalancer(loadBalancer) {
  return {
    id: loadBalancer.id,
    name: loadBalancer.name,
    status: loadBalancer.status,
    region: regionSlug(loadBalancer),
    attachedDroplets: safeArray(loadBalancer.droplet_ids).length,
  };
}

function mapReservedIp(reservedIp) {
  return {
    region: regionSlug(reservedIp),
    assigned: Boolean(reservedIp.droplet),
    projectId: reservedIp.project_id || null,
  };
}

function mapKubernetesCluster(cluster) {
  return {
    id: cluster.id,
    name: cluster.name,
    region: cluster.region || null,
    version: cluster.version || null,
    status: cluster.status?.state || cluster.status || null,
    nodePools: safeArray(cluster.node_pools).length,
  };
}

function mapCertificate(certificate) {
  return {
    id: certificate.id,
    name: certificate.name,
    state: certificate.state || null,
    type: certificate.type || null,
    notAfter: certificate.not_after || null,
  };
}

function mapCdnEndpoint(endpoint) {
  return {
    id: endpoint.id,
    origin: endpoint.origin || null,
    ttl: endpoint.ttl ?? null,
    certificateId: endpoint.certificate_id || null,
    createdAt: endpoint.created_at || null,
  };
}

function mapFunctionNamespace(namespace) {
  return {
    namespace: namespace.namespace || namespace.label || null,
    region: namespace.region || null,
    createdAt: namespace.created_at || null,
  };
}

function mapCustomImage(image) {
  return {
    id: image.id,
    name: image.name,
    status: image.status || null,
    type: image.type || null,
    regions: safeArray(image.regions),
    sizeGigabytes: image.size_gigabytes ?? null,
    createdAt: image.created_at || null,
  };
}

function mapSshKey(key) {
  return {
    id: key.id,
    name: key.name,
    fingerprint: key.fingerprint || null,
  };
}

function mapTag(tag) {
  return {
    name: tag.name,
    resourceCount: tag.resources
      ? Object.values(tag.resources).reduce(
          (total, resource) => total + Number(resource?.count || 0),
          0,
        )
      : 0,
  };
}

function mapUptimeCheck(check) {
  return {
    id: check.id,
    name: check.name,
    type: check.type || null,
    enabled: check.enabled !== false,
    regions: safeArray(check.regions),
  };
}

function mapProject(project) {
  return {
    id: project.id,
    name: project.name,
    purpose: project.purpose || null,
    environment: project.environment || null,
    isDefault: Boolean(project.is_default),
  };
}

function mapAction(action) {
  return {
    id: action.id,
    status: action.status,
    type: action.type,
    resourceType: action.resource_type || null,
    region: regionSlug(action),
    startedAt: action.started_at,
    completedAt: action.completed_at,
  };
}

function buildFindings(audit) {
  const findings = [];
  if (audit.account.emailVerified === false) {
    findings.push({
      severity: "warning",
      code: "ACCOUNT_EMAIL_NOT_VERIFIED",
      message: "Имейлът на DigitalOcean акаунта не е потвърден.",
    });
  }
  const dropletsWithoutBackups = audit.droplets.filter(
    (droplet) => !droplet.backupsEnabled,
  );
  if (dropletsWithoutBackups.length) {
    findings.push({
      severity: "warning",
      code: "DROPLETS_WITHOUT_BACKUPS",
      message: `${dropletsWithoutBackups.length} Droplet(а) са без включени автоматични backups.`,
    });
  }
  const unhealthyDroplets = audit.droplets.filter(
    (droplet) => droplet.status !== "active",
  );
  if (unhealthyDroplets.length) {
    findings.push({
      severity: "warning",
      code: "DROPLETS_NOT_ACTIVE",
      message: `${unhealthyDroplets.length} Droplet(а) не са със статус active.`,
    });
  }
  if (audit.droplets.length && !audit.firewalls.length) {
    findings.push({
      severity: "warning",
      code: "NO_CLOUD_FIREWALLS",
      message: "Има Droplets, но няма открити Cloud Firewalls.",
    });
  }
  const unattachedVolumes = audit.volumes.filter(
    (volume) => volume.attachedDroplets === 0,
  );
  if (unattachedVolumes.length) {
    findings.push({
      severity: "info",
      code: "UNATTACHED_VOLUMES",
      message: `${unattachedVolumes.length} volume(а) не са свързани към Droplet.`,
    });
  }
  const inactiveApps = audit.apps.filter(
    (app) =>
      app.activeDeploymentPhase &&
      !["ACTIVE", "SUPERSEDED"].includes(app.activeDeploymentPhase),
  );
  if (inactiveApps.length) {
    findings.push({
      severity: "warning",
      code: "APPS_NOT_ACTIVE",
      message: `${inactiveApps.length} приложение(я) нямат активен успешен deployment.`,
    });
  }
  const unhealthyDatabases = audit.databases.filter(
    (database) => database.status && database.status !== "online",
  );
  if (unhealthyDatabases.length) {
    findings.push({
      severity: "warning",
      code: "DATABASES_NOT_ONLINE",
      message: `${unhealthyDatabases.length} управлявана база не е със статус online.`,
    });
  }
  const opensearchBackups = safeArray(audit.databaseBackups).filter(
    ({ engine }) => engine === "opensearch",
  );
  if (
    audit.databases.some(({ engine }) => engine === "opensearch") &&
    !opensearchBackups.some(({ status }) => status === "verified")
  ) {
    findings.push({
      severity: "warning",
      code: "OPENSEARCH_BACKUPS_UNVERIFIED",
      message:
        "Backup точките на управлявания OpenSearch не можаха да бъдат проверени.",
    });
  } else if (
    opensearchBackups.some(
      ({ status, backupCount }) => status === "verified" && backupCount === 0,
    )
  ) {
    findings.push({
      severity: "warning",
      code: "OPENSEARCH_BACKUPS_EMPTY",
      message:
        "DigitalOcean backup API не върна restore точки за управлявания OpenSearch.",
    });
  }
  const unassignedReservedIps = audit.reservedIps.filter(
    (reservedIp) => !reservedIp.assigned,
  );
  if (unassignedReservedIps.length) {
    findings.push({
      severity: "info",
      code: "UNASSIGNED_RESERVED_IPS",
      message: `${unassignedReservedIps.length} Reserved IP адрес(а) не са свързани към Droplet.`,
    });
  }
  const failedActions = audit.actions.filter(
    (action) => action.status === "errored",
  );
  if (failedActions.length) {
    findings.push({
      severity: "warning",
      code: "RECENT_FAILED_ACTIONS",
      message: `${failedActions.length} от последните действия са завършили с грешка.`,
    });
  }
  const invalidCertificates = audit.certificates.filter(
    (certificate) =>
      certificate.state && !["verified", "pending"].includes(certificate.state),
  );
  if (invalidCertificates.length) {
    findings.push({
      severity: "warning",
      code: "CERTIFICATES_NOT_VERIFIED",
      message: `${invalidCertificates.length} сертификат(а) не са verified.`,
    });
  }
  const disabledUptimeChecks = audit.uptimeChecks.filter(
    (check) => !check.enabled,
  );
  if (disabledUptimeChecks.length) {
    findings.push({
      severity: "info",
      code: "UPTIME_CHECKS_DISABLED",
      message: `${disabledUptimeChecks.length} uptime проверка(и) са изключени.`,
    });
  }
  if (!findings.length) {
    findings.push({
      severity: "ok",
      code: "NO_OBVIOUS_RISKS",
      message:
        "Автоматичната проверка не откри предупреждения в достъпните полета. Това не доказва, че няма други проблеми.",
    });
  }
  return findings;
}

export async function getDigitalOceanAccountAudit(options = {}) {
  requiredToken(options.env);
  const settled = await Promise.all(
    AUDIT_RESOURCES.map(async ([name, path]) => {
      try {
        return [name, { ok: true, data: await request(path, options) }];
      } catch (error) {
        return [
          name,
          {
            ok: false,
            error: {
              code: error?.code || "DIGITALOCEAN_UPSTREAM_ERROR",
              status: error?.status || 502,
              message: error?.message || "Неизвестна грешка.",
            },
          },
        ];
      }
    }),
  );
  const successfulRequests = settled.filter(([, result]) => result.ok).length;
  if (!successfulRequests) {
    const firstFailure = settled.find(([, result]) => !result.ok)?.[1]?.error;
    throw new DigitalOceanError(
      firstFailure?.message || "DigitalOcean API не върна достъпни данни.",
      firstFailure?.status || 502,
      firstFailure?.code || "DIGITALOCEAN_UPSTREAM_ERROR",
    );
  }
  const results = Object.fromEntries(settled);
  const read = (name, key) =>
    results[name]?.ok ? safeArray(results[name].data?.[key]) : [];
  const account = results.account?.ok
    ? results.account.data?.account || {}
    : {};
  const balance = results.balance?.ok ? results.balance.data || {} : {};
  const rawDatabases = read("databases", "databases");
  const databaseBackups = await getDigitalOceanDatabaseBackupInventory(
    rawDatabases,
    options,
  );
  const audit = {
    checkedAt: new Date().toISOString(),
    account: {
      status: account.status || null,
      emailVerified:
        typeof account.email_verified === "boolean"
          ? account.email_verified
          : null,
      dropletLimit: account.droplet_limit ?? null,
      volumeLimit: account.volume_limit ?? null,
    },
    billing: {
      currency: balance.currency || null,
      monthToDateUsage: balance.month_to_date_usage || null,
      accountBalance: balance.account_balance || null,
      monthToDateBalance: balance.month_to_date_balance || null,
      generatedAt: balance.generated_at || null,
    },
    apps: read("apps", "apps").map(mapApp),
    droplets: read("droplets", "droplets").map(mapDroplet),
    databases: rawDatabases.map(mapDatabase),
    databaseBackups,
    volumes: read("volumes", "volumes").map(mapVolume),
    snapshots: read("snapshots", "snapshots").map(mapSnapshot),
    vpcs: read("vpcs", "vpcs").map(mapVpc),
    firewalls: read("firewalls", "firewalls").map(mapFirewall),
    domains: read("domains", "domains").map(mapDomain),
    loadBalancers: read("loadBalancers", "load_balancers").map(mapLoadBalancer),
    reservedIps: read("reservedIps", "reserved_ips").map(mapReservedIp),
    kubernetes: read("kubernetes", "kubernetes").map(mapKubernetesCluster),
    certificates: read("certificates", "certificates").map(mapCertificate),
    cdnEndpoints: read("cdnEndpoints", "endpoints").map(mapCdnEndpoint),
    functions: read("functions", "namespaces").map(mapFunctionNamespace),
    customImages: read("customImages", "images").map(mapCustomImage),
    sshKeys: read("sshKeys", "ssh_keys").map(mapSshKey),
    tags: read("tags", "tags").map(mapTag),
    uptimeChecks: read("uptimeChecks", "checks").map(mapUptimeCheck),
    registry:
      results.registry?.ok && results.registry.data?.registry
        ? {
            name: results.registry.data.registry.name || null,
            region: results.registry.data.registry.region || null,
            storageUsageBytes:
              results.registry.data.registry.storage_usage_bytes ?? null,
            storageUsageUpdatedAt:
              results.registry.data.registry.storage_usage_bytes_updated_at ||
              null,
          }
        : null,
    projects: read("projects", "projects").map(mapProject),
    actions: read("actions", "actions").map(mapAction),
    unavailable: settled
      .filter(([, result]) => !result.ok)
      .map(([resource, result]) => ({
        resource,
        status: result.error.status,
        message: result.error.message,
      })),
  };
  audit.findings = buildFindings(audit);
  return audit;
}

export function formatDigitalOceanAudit(audit) {
  const checkedSections = AUDIT_RESOURCES.length - audit.unavailable.length;
  const counts = [
    `приложения ${audit.apps.length}`,
    `Droplets ${audit.droplets.length}`,
    `бази ${audit.databases.length}`,
    `volumes ${audit.volumes.length}`,
    `snapshots ${audit.snapshots.length}`,
    `VPC ${audit.vpcs.length}`,
    `firewalls ${audit.firewalls.length}`,
    `домейни ${audit.domains.length}`,
    `load balancers ${audit.loadBalancers.length}`,
    `Kubernetes ${audit.kubernetes.length}`,
    `сертификати ${audit.certificates.length}`,
    `CDN ${audit.cdnEndpoints.length}`,
    `Functions ${audit.functions.length}`,
    `custom images ${audit.customImages.length}`,
    `uptime проверки ${audit.uptimeChecks.length}`,
  ].join(", ");
  const billing =
    audit.billing.monthToDateUsage || audit.billing.accountBalance
      ? `Разход този месец: ${audit.billing.monthToDateUsage || "няма данни"} ${audit.billing.currency || ""}; баланс: ${audit.billing.accountBalance || "няма данни"} ${audit.billing.currency || ""}.`
      : "Разходи: няма достъпни данни.";
  const databaseBackups = safeArray(audit.databaseBackups);
  const backupLines = databaseBackups.length
    ? databaseBackups.map((backup, index) => {
        if (backup.status !== "verified") {
          return `• ${backup.engine} база #${index + 1}: backup точките не са проверени (${backup.errorCode || "неизвестна причина"}).`;
        }
        const range = backup.backupCount
          ? `; период ${backup.oldestCreatedAt || "неизвестен"} – ${backup.newestCreatedAt || "неизвестен"}`
          : "";
        return `• ${backup.engine} база #${index + 1}: ${backup.backupCount} налични backup точки${range}.`;
      })
    : ["• Няма открити управлявани бази за backup проверка."];
  return [
    "DigitalOcean — преглед на ресурсите само за четене.",
    `Акаунт: ${audit.account.status || "неизвестен статус"}.`,
    `Покритие: проверени ${checkedSections} от ${AUDIT_RESOURCES.length} заявени секции.`,
    `Ресурси: ${counts}.`,
    billing,
    "Backup точки на управляваните бази:",
    ...backupLines,
    "Находки:",
    ...audit.findings.map((finding) => `• ${finding.message}`),
    audit.unavailable.length
      ? `Непроверени секции: ${audit.unavailable.map(({ resource }) => resource).join(", ")}.`
      : "Всички заявени секции са проверени.",
    "Ограничение: това е автоматичен преглед на данните от DigitalOcean API, а не доказателство, че приложението, архивите, тайните и всички настройки за сигурност са правилни.",
    "Не са направени промени.",
  ].join("\n");
}

export function formatDigitalOceanOpenSearchBackupAudit(audit) {
  const backups = safeArray(audit?.databaseBackups);
  const backupLines = backups.length
    ? backups.map((backup, index) => {
        if (backup.status !== "verified") {
          const reason =
            backup.errorCode === "DIGITALOCEAN_FORBIDDEN"
              ? "DigitalOcean token-ът няма право да прочете backup точките"
              : backup.errorCode === "DIGITALOCEAN_TOKEN_INVALID"
                ? "DigitalOcean token-ът е невалиден, изтекъл или отнет"
                : "DigitalOcean API не върна проверими backup данни";
          return `• OpenSearch база #${index + 1}: не е проверена — ${reason}.`;
        }
        const range = backup.backupCount
          ? `; най-стара ${backup.oldestCreatedAt || "неизвестна"}; най-нова ${backup.newestCreatedAt || "неизвестна"}`
          : "";
        return `• OpenSearch база #${index + 1}: ${backup.backupCount} налични restore точки${range}.`;
      })
    : ["• Не е открита управлявана OpenSearch база в достъпния акаунт."];

  return [
    "OpenSearch backup инвентар — проверка само за четене.",
    ...backupLines,
    "Не е създаван restore или fork и не са променяни данни.",
  ].join("\n");
}

export function formatDigitalOceanStatus(status) {
  const active = status.activeDeployment;
  return [
    `DigitalOcean приложение: ${status.name}.`,
    `Активен деплой: ${active?.phase || "няма данни"}${active?.id ? ` (${active.id})` : ""}.`,
    status.inProgressDeployment
      ? `Текущ деплой: ${status.inProgressDeployment.phase} (${status.inProgressDeployment.id}).`
      : "Няма текущ деплой.",
    status.liveUrl ? `Адрес: ${status.liveUrl}` : null,
    `Environment variables: ${status.environmentVariables?.length || 0} имена; стойностите не се връщат.`,
    `Последни деплои: ${status.deployments.length}.`,
  ]
    .filter(Boolean)
    .join("\n");
}
