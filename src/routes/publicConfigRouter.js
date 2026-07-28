import express from "express";

const router = express.Router();

const DEFAULT_URLS = Object.freeze({
  chatgptWorkUrl: "https://chatgpt.com/",
  digitalOceanUrl: "https://cloud.digitalocean.com/",
  cloudflareUrl: "https://dash.cloudflare.com/",
});

export function resolvePublicHttpsUrl(value, fallback) {
  try {
    const url = new URL(String(value || fallback));
    return url.protocol === "https:" ? url.href : fallback;
  } catch {
    return fallback;
  }
}

export function getPublicClientConfig(env = process.env) {
  return {
    chatgptWorkUrl: resolvePublicHttpsUrl(
      env.CHATGPT_WORK_URL,
      DEFAULT_URLS.chatgptWorkUrl,
    ),
    digitalOceanUrl: resolvePublicHttpsUrl(
      env.DIGITALOCEAN_DASHBOARD_URL,
      DEFAULT_URLS.digitalOceanUrl,
    ),
    cloudflareUrl: resolvePublicHttpsUrl(
      env.CLOUDFLARE_DASHBOARD_URL,
      DEFAULT_URLS.cloudflareUrl,
    ),
  };
}

router.get("/", (req, res) => {
  res.json(getPublicClientConfig());
});

export default router;
