import { rateLimit } from "express-rate-limit";

// A limit counts only as a whole number above zero. Anything else ("abc",
// "0", "10abc", "1e3", empty) keeps the limit the code names for that group.
export function positiveInteger(value, fallback) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/u.test(text)) return fallback;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function createApiRateLimiter({
  limit,
  fallback = 60,
  windowMs = 15 * 60 * 1000,
  code = "RATE_LIMIT_EXCEEDED",
  message = "Твърде много заявки. Опитай отново след малко.",
} = {}) {
  return rateLimit({
    windowMs,
    limit: positiveInteger(limit, fallback),
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler(_req, res) {
      res.status(429).json({ error: message, code });
    },
  });
}

// Reading whether one is signed in (every page load, every open tab) is not
// an attempt to sign in. It gets its own, wider limit, so the page loads of a
// home or a mobile network behind one address do not lock its people out of
// the site (28.11: 429 on /api/auth/session at 14:11 and 14:12 UTC). Only
// the named GET paths count as reads, matched as Express routes them (any
// case, one trailing slash); everything else keeps the strict limit.
export function limitReadsApart({ readPaths = [], readLimiter, otherLimiter }) {
  const reads = new Set(readPaths.map((path) => path.toLowerCase()));
  return (req, res, next) => {
    const path = String(req.path || "").toLowerCase().replace(/(.)\/$/u, "$1");
    const read = (req.method === "GET" || req.method === "HEAD") && reads.has(path);
    return (read ? readLimiter : otherLimiter)(req, res, next);
  };
}

export function createRateLimiters(env = process.env) {
  return {
    oauthRateLimiter: createApiRateLimiter({
      limit: env.OAUTH_RATE_LIMIT,
      fallback: 60,
      code: "OAUTH_RATE_LIMIT_EXCEEDED",
      message: "Има твърде много опити за свързване. Опитай отново след малко.",
    }),
    sessionReadRateLimiter: createApiRateLimiter({
      limit: env.SESSION_READ_RATE_LIMIT,
      fallback: 600,
      code: "SESSION_READ_RATE_LIMIT_EXCEEDED",
    }),
    privateApiRateLimiter: createApiRateLimiter({
      limit: env.PRIVATE_API_RATE_LIMIT,
      fallback: 300,
      code: "PRIVATE_API_RATE_LIMIT_EXCEEDED",
    }),
    paidAiRateLimiter: createApiRateLimiter({
      limit: env.PAID_AI_RATE_LIMIT,
      fallback: 60,
      code: "PAID_AI_RATE_LIMIT_EXCEEDED",
      message:
        "Достигнат е временният лимит за AI заявки. Опитай отново след малко.",
    }),
  };
}
