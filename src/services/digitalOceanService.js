const DEFAULT_API_URL = "https://api.digitalocean.com/v2";

export class DigitalOceanError extends Error {
  constructor(message, status = 502, code = "DIGITALOCEAN_ERROR") {
    super(message);
    this.name = "DigitalOceanError";
    this.status = status;
    this.code = code;
  }
}

function requiredConfig(env = process.env) {
  const token = env.DIGITALOCEAN_API_TOKEN || env.DIGITALOCEAN_TOKEN;
  const appId = env.DIGITALOCEAN_APP_ID;
  if (!token || !appId) {
    throw new DigitalOceanError(
      "DigitalOcean мостът не е конфигуриран. Нужни са DIGITALOCEAN_API_TOKEN и DIGITALOCEAN_APP_ID.",
      503,
      "DIGITALOCEAN_NOT_CONFIGURED",
    );
  }
  return { token, appId };
}

async function request(path, { env = process.env, fetchImpl = fetch } = {}) {
  const { token } = requiredConfig(env);
  const response = await fetchImpl(
    `${env.DIGITALOCEAN_API_URL || DEFAULT_API_URL}${path}`,
    { headers: { Accept: "application/json", Authorization: `Bearer ${token}` } },
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

export async function getDigitalOceanAppStatus(options = {}) {
  const { appId } = requiredConfig(options.env);
  const [appData, deploymentsData] = await Promise.all([
    request(`/apps/${encodeURIComponent(appId)}`, options),
    request(`/apps/${encodeURIComponent(appId)}/deployments?page=1&per_page=5`, options),
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
    deployments: deployments.map((deployment) => ({
      id: deployment.id,
      phase: deployment.phase,
      cause: deployment.cause,
      createdAt: deployment.created_at,
      updatedAt: deployment.updated_at,
    })),
  };
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
    `Последни деплои: ${status.deployments.length}.`,
  ].filter(Boolean).join("\n");
}
