import { rateLimit } from "express-rate-limit";

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function createApiRateLimiter({
  limit,
  windowMs = 15 * 60 * 1000,
  code = "RATE_LIMIT_EXCEEDED",
  message = "Твърде много заявки. Опитай отново след малко.",
} = {}) {
  return rateLimit({
    windowMs,
    limit: positiveInteger(limit, 60),
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler(_req, res) {
      res.status(429).json({ error: message, code });
    },
  });
}

export function createRateLimiters(env = process.env) {
  return {
    oauthRateLimiter: createApiRateLimiter({
      limit: env.OAUTH_RATE_LIMIT,
      code: "OAUTH_RATE_LIMIT_EXCEEDED",
      message: "Има твърде много опити за свързване. Опитай отново след малко.",
    }),
    privateApiRateLimiter: createApiRateLimiter({
      limit: env.PRIVATE_API_RATE_LIMIT || 300,
      code: "PRIVATE_API_RATE_LIMIT_EXCEEDED",
    }),
    paidAiRateLimiter: createApiRateLimiter({
      limit: env.PAID_AI_RATE_LIMIT || 60,
      code: "PAID_AI_RATE_LIMIT_EXCEEDED",
      message:
        "Достигнат е временният лимит за AI заявки. Опитай отново след малко.",
    }),
  };
}
