const MAX_SECRET_VERSIONS = 16;
const SECRET_REF =
  /^(?:projects\/([a-z0-9-]+)\/secrets\/)?([a-zA-Z0-9_-]{1,255})$/u;
const SECRET_VERSION = /^(?:[1-9][0-9]*|[a-zA-Z][a-zA-Z0-9_-]{0,62})$/u;

export function cloudRunSecretReferences(service) {
  const template = service?.template;
  const containers = Array.isArray(template?.containers)
    ? template.containers
    : [];
  const volumes = Array.isArray(template?.volumes) ? template.volumes : [];
  const environmentRefs = containers.flatMap((container) =>
    (Array.isArray(container?.env) ? container.env : []).flatMap(
      ({ valueSource }) =>
        valueSource?.secretKeyRef ? [valueSource.secretKeyRef] : [],
    ),
  );
  const volumeRefs = volumes.flatMap(({ secret }) => {
    if (!secret) return [];
    return (secret.items?.length ? secret.items : [{ version: "latest" }]).map(
      ({ version }) => ({ secret: secret.secret, version }),
    );
  });
  const unique = new Map();
  for (const { secret, version } of [...environmentRefs, ...volumeRefs]) {
    unique.set(JSON.stringify([secret, version]), { secret, version });
  }
  return [...unique.values()];
}

export async function checkCloudRunSecretVersions({
  check,
  cloudRun,
  references,
  projectId,
  projectNumber,
}) {
  if (cloudRun?.status === "unavailable" || !references) {
    return {
      status: "unavailable",
      errorCode: "CLOUD_RUN_SECRET_REFERENCES_UNAVAILABLE",
    };
  }
  if (!references.length) {
    return {
      status: "unavailable",
      errorCode: "CLOUD_RUN_SECRET_REFERENCES_EMPTY",
      checkedVersions: 0,
    };
  }

  const checks = await Promise.all(
    references.slice(0, MAX_SECRET_VERSIONS).map(({ secret, version }) => {
      const match = typeof secret === "string" && secret.match(SECRET_REF);
      if (
        !match ||
        typeof version !== "string" ||
        !SECRET_VERSION.test(version)
      ) {
        return { status: "unavailable", errorCode: "SECRET_REFERENCE_INVALID" };
      }
      const [, project, name] = match;
      if (project && project !== projectId && project !== projectNumber) {
        return {
          status: "unavailable",
          errorCode: "SECRET_PROJECT_NOT_VERIFIED",
        };
      }
      return check(
        `https://secretmanager.googleapis.com/v1/projects/${projectId}/secrets/${name}/versions/${version}`,
        ({ state }) =>
          state === "ENABLED"
            ? { status: "pass" }
            : { status: "fail", errorCode: "SECRET_VERSION_NOT_ENABLED" },
      );
    }),
  );
  const enabled = checks.filter(({ status }) => status === "pass").length;
  const failed = checks.filter(({ status }) => status === "fail").length;
  const skipped = references.length - enabled - failed;
  const errorCodes = [
    ...new Set(checks.map(({ errorCode }) => errorCode).filter(Boolean)),
  ];
  if (references.length > MAX_SECRET_VERSIONS)
    errorCodes.push("SECRET_VERSION_LIMIT_REACHED");
  return {
    status: failed ? "fail" : skipped ? "unavailable" : "pass",
    referencedVersions: references.length,
    enabledVersions: enabled,
    failedVersions: failed,
    unverifiedVersions: skipped,
    errorCodes,
  };
}

export function checkCloudProject({ check, projectId }) {
  return check(
    `https://cloudresourcemanager.googleapis.com/v3/projects/${projectId}`,
    (data) => ({
      status: data.state === "ACTIVE" ? "pass" : "fail",
      ...(data.state !== "ACTIVE"
        ? { errorCode: "GOOGLE_CLOUD_PROJECT_NOT_ACTIVE" }
        : {}),
      projectNumber: /^projects\/[0-9]+$/u.test(data.name || "")
        ? data.name.split("/")[1]
        : null,
    }),
  );
}

export function checkCloudRunTelemetry({
  check,
  projectId,
  service,
  region,
  checkedAt,
}) {
  const start = new Date(Date.parse(checkedAt) - 30 * 60_000).toISOString();
  const filters = [
    'resource.type = "cloud_run_revision"',
    `resource.labels.project_id = ${JSON.stringify(projectId)}`,
    `resource.labels.service_name = ${JSON.stringify(service)}`,
    `resource.labels.location = ${JSON.stringify(region)}`,
  ];
  const monitoringQuery = new URLSearchParams({
    filter: [
      'metric.type = "run.googleapis.com/request_count"',
      ...filters,
    ].join(" AND "),
    "interval.startTime": start,
    "interval.endTime": checkedAt,
    view: "HEADERS",
    pageSize: "1",
  });
  const monitor = check(
    `https://monitoring.googleapis.com/v3/projects/${projectId}/timeSeries?${monitoringQuery}`,
    (data) => ({
      windowMinutes: 30,
      samplePresent:
        Array.isArray(data.timeSeries) && data.timeSeries.length > 0,
    }),
  );
  const logs = check(
    "https://logging.googleapis.com/v2/entries:list",
    (data) => {
      const recentErrorFound =
        Array.isArray(data.entries) && data.entries.length > 0;
      return {
        windowMinutes: 30,
        recentErrorFound,
        ...(!recentErrorFound && data.nextPageToken
          ? { status: "unavailable", errorCode: "LOG_SEARCH_INCOMPLETE" }
          : {}),
      };
    },
    {
      method: "POST",
      body: {
        resourceNames: [`projects/${projectId}`],
        filter: [
          ...filters,
          "severity >= ERROR",
          `timestamp >= "${start}"`,
          `timestamp <= "${checkedAt}"`,
        ].join(" AND "),
        orderBy: "timestamp desc",
        pageSize: 1,
      },
    },
  );
  return Promise.all([monitor, logs]);
}
