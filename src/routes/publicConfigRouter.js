import express from "express";

const router = express.Router();

const DEFAULT_URLS = Object.freeze({
  chatgptWorkUrl: "https://chatgpt.com/",
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
  };
}

router.get("/", (req, res) => {
  res.json(getPublicClientConfig());
});

export default router;
