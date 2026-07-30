const DEFAULT_API_URL = "https://api.digitalocean.com/v2";

export class DigitalOceanError extends Error {
  constructor(message, status = 502, code = "DIGITALOCEAN_ERROR") {
    super(message);
    this.name = "DigitalOceanError";
    this.status = status;
    this.code = code;
  }
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

async function request(path, { env = process.env, fetchImpl = fetch } = {}) {
  const token = requiredToken(env);
  const response = await fetchImpl(
    `${env.DIGITALOCEAN_API_URL || DEFAULT_API_URL}${path}`,
    {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    },
  );
  if (!response.ok) {
    throw new DigitalOceanError(
      `DigitalOcean API върна грешка ${response.status}.`,
      response.status === 401 || response.status === 403 ? 401 : 502,
      "DIGITALOCEAN_UPSTREAM_ERROR",
    );
  }
  return response.json();
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
    databases: read("databases", "databases").map(mapDatabase),
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
  return [
    "DigitalOcean — преглед на ресурсите само за четене.",
    `Акаунт: ${audit.account.status || "неизвестен статус"}.`,
    `Покритие: проверени ${checkedSections} от ${AUDIT_RESOURCES.length} заявени секции.`,
    `Ресурси: ${counts}.`,
    billing,
    "Находки:",
    ...audit.findings.map((finding) => `• ${finding.message}`),
    audit.unavailable.length
      ? `Непроверени секции: ${audit.unavailable.map(({ resource }) => resource).join(", ")}.`
      : "Всички заявени секции са проверени.",
    "Ограничение: това е автоматичен преглед на данните от DigitalOcean API, а не доказателство, че приложението, архивите, тайните и всички настройки за сигурност са правилни.",
    "Не са направени промени.",
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
