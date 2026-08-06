const DEFAULT_API_URL = "https://api.cloudflare.com/client/v4";
const DEFAULT_ZONE_NAME = "synchron.foundation";
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const VALID_ZONE_STATUSES = new Set([
  "initializing",
  "pending",
  "active",
  "moved",
]);

export class CloudflareError extends Error {
  constructor(message, status = 502, code = "CLOUDFLARE_ERROR") {
    super(message);
    this.name = "CloudflareError";
    this.status = status;
    this.code = code;
  }
}

function normalizeZoneName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\.$/u, "");
}

function requiredConfig(env = process.env) {
  const token = env.CLOUDFLARE_API_TOKEN;
  const zoneId = String(env.CLOUDFLARE_ZONE_ID || "").trim() || null;
  const zoneName = normalizeZoneName(
    env.CLOUDFLARE_ZONE_NAME || DEFAULT_ZONE_NAME,
  );
  if (!token) {
    throw new CloudflareError(
      "Cloudflare read-only връзката не е конфигурирана.",
      503,
      "CLOUDFLARE_NOT_CONFIGURED",
    );
  }
  if (!zoneId && !/^[a-z0-9.-]+$/u.test(zoneName)) {
    throw new CloudflareError(
      "Cloudflare зоната е невалидна.",
      503,
      "CLOUDFLARE_INVALID_ZONE",
    );
  }
  return { token, zoneId, zoneName };
}

function validateZone(zone, { expectedId = null, expectedName }) {
  const valid =
    zone &&
    typeof zone === "object" &&
    !Array.isArray(zone) &&
    typeof zone.id === "string" &&
    zone.id.trim() &&
    (!expectedId || zone.id === expectedId) &&
    normalizeZoneName(zone.name) === expectedName &&
    VALID_ZONE_STATUSES.has(zone.status);
  if (!valid) {
    throw new CloudflareError(
      "Cloudflare върна невалидна зона.",
      502,
      "CLOUDFLARE_INVALID_RESPONSE",
    );
  }
  return zone;
}

function isValidDnsRecord(record) {
  return (
    record &&
    typeof record === "object" &&
    !Array.isArray(record) &&
    [record.id, record.type, record.name, record.content].every(
      (value) => typeof value === "string" && value.trim(),
    )
  );
}

async function request(
  path,
  { env = process.env, fetchImpl = fetch, signal = undefined } = {},
) {
  const { token } = requiredConfig(env);
  const parsedTimeout = Number.parseInt(env.CLOUDFLARE_REQUEST_TIMEOUT_MS, 10);
  let response;
  try {
    response = await fetchImpl(
      `${env.CLOUDFLARE_API_URL || DEFAULT_API_URL}${path}`,
      {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        },
        signal:
          signal ||
          AbortSignal.timeout(
            Number.isFinite(parsedTimeout) && parsedTimeout > 0
              ? parsedTimeout
              : DEFAULT_REQUEST_TIMEOUT_MS,
          ),
      },
    );
  } catch (error) {
    const timedOut = ["AbortError", "TimeoutError"].includes(error?.name);
    throw new CloudflareError(
      timedOut
        ? "Cloudflare API не отговори в допустимото време."
        : "Cloudflare API временно не е достъпен.",
      502,
      timedOut ? "CLOUDFLARE_TIMEOUT" : "CLOUDFLARE_NETWORK_ERROR",
    );
  }
  const data = await response.json().catch(() => ({}));
  if (
    !response.ok ||
    data?.success !== true ||
    !Object.prototype.hasOwnProperty.call(data, "result")
  ) {
    throw new CloudflareError(
      `Cloudflare API върна грешка ${response.status}.`,
      response.status === 401 || response.status === 403 ? 401 : 502,
      "CLOUDFLARE_UPSTREAM_ERROR",
    );
  }
  return data;
}

export async function getCloudflareZoneStatus(options = {}) {
  const { zoneId: configuredZoneId, zoneName } = requiredConfig(options.env);
  let zone;
  if (configuredZoneId) {
    const zoneData = await request(
      `/zones/${encodeURIComponent(configuredZoneId)}`,
      options,
    );
    zone = validateZone(zoneData.result, {
      expectedId: configuredZoneId,
      expectedName: zoneName,
    });
  } else {
    const zoneData = await request(
      `/zones?name=${encodeURIComponent(zoneName)}&per_page=50`,
      options,
    );
    const matches = Array.isArray(zoneData.result)
      ? zoneData.result.filter(
          (candidate) =>
            normalizeZoneName(candidate?.name) === zoneName,
        )
      : [];
    if (matches.length !== 1 || !matches[0]?.id) {
      throw new CloudflareError(
        "Cloudflare зоната не беше намерена еднозначно.",
        503,
        "CLOUDFLARE_ZONE_NOT_FOUND",
      );
    }
    zone = validateZone(matches[0], { expectedName: zoneName });
  }

  const zoneId = zone.id || configuredZoneId;
  const zonePath = `/zones/${encodeURIComponent(zoneId)}`;
  const recordsData = await request(
    `${zonePath}/dns_records?per_page=100`,
    options,
  );
  if (
    !Array.isArray(recordsData.result) ||
    !recordsData.result.every(isValidDnsRecord)
  ) {
    throw new CloudflareError(
      "Cloudflare върна невалиден DNS отговор.",
      502,
      "CLOUDFLARE_INVALID_RESPONSE",
    );
  }
  const records = recordsData.result;
  return {
    id: zone.id,
    name: zone.name,
    status: zone.status,
    paused: Boolean(zone.paused),
    nameservers: zone.name_servers || [],
    records: records.map((record) => ({
      id: record.id,
      type: record.type,
      name: record.name,
      content: record.content,
      proxied: Boolean(record.proxied),
      ttl: record.ttl,
    })),
  };
}

export function formatCloudflareStatus(status) {
  const importantRecords = status.records
    .filter((record) => ["A", "AAAA", "CNAME"].includes(record.type))
    .slice(0, 12);
  return [
    `Cloudflare зона: ${status.name}.`,
    `Статус: ${status.status}${status.paused ? " (паузирана)" : ""}.`,
    `DNS записи: ${status.records.length}.`,
    ...importantRecords.map(
      (record) =>
        `• ${record.type} ${record.name} → ${record.content}${record.proxied ? " (през Cloudflare)" : ""}`,
    ),
  ].join("\n");
}
