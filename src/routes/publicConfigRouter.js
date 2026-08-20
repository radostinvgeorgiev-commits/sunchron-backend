import express from "express";

const router = express.Router();

const DEFAULT_URLS = Object.freeze({
  chatgptWorkUrl: "https://chatgpt.com/",
  googleCloudConsoleUrl: "https://console.cloud.google.com/run",
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
    googleCloudConsoleUrl: resolvePublicHttpsUrl(
      env.GOOGLE_CLOUD_CONSOLE_URL,
      DEFAULT_URLS.googleCloudConsoleUrl,
    ),
  };
}

router.get("/", (req, res) => {
  res.json(getPublicClientConfig());
});

export default router;
