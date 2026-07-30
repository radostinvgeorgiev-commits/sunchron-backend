const DEFAULT_API_URL = "https://api.cloudflare.com/client/v4";

export class CloudflareError extends Error {
  constructor(message, status = 502, code = "CLOUDFLARE_ERROR") {
    super(message);
    this.name = "CloudflareError";
    this.status = status;
    this.code = code;
  }
}

function requiredConfig(env = process.env) {
  const token = env.CLOUDFLARE_API_TOKEN;
  const zoneId = env.CLOUDFLARE_ZONE_ID;
  if (!token || !zoneId) {
    throw new CloudflareError(
      "Cloudflare мостът не е конфигуриран. Нужни са CLOUDFLARE_API_TOKEN и CLOUDFLARE_ZONE_ID.",
      503,
      "CLOUDFLARE_NOT_CONFIGURED",
    );
  }
  return { token, zoneId };
}

async function request(path, { env = process.env, fetchImpl = fetch } = {}) {
  const { token } = requiredConfig(env);
  const response = await fetchImpl(
    `${env.CLOUDFLARE_API_URL || DEFAULT_API_URL}${path}`,
    { headers: { Accept: "application/json", Authorization: `Bearer ${token}` } },
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) {
    throw new CloudflareError(
      `Cloudflare API върна грешка ${response.status}.`,
      response.status === 401 || response.status === 403 ? 401 : 502,
      "CLOUDFLARE_UPSTREAM_ERROR",
    );
  }
  return data;
}

export async function getCloudflareZoneStatus(options = {}) {
  const { zoneId } = requiredConfig(options.env);
  const zonePath = `/zones/${encodeURIComponent(zoneId)}`;
  const [zoneData, recordsData] = await Promise.all([
    request(zonePath, options),
    request(`${zonePath}/dns_records?per_page=100`, options),
  ]);
  const zone = zoneData.result || {};
  const records = recordsData.result || [];
  return {
    id: zone.id || zoneId,
    name: zone.name || "неизвестна зона",
    status: zone.status || "unknown",
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
