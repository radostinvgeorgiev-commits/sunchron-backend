import express from "express";
import dotenv from "dotenv";
import {
  createOpenSearchClient,
  getOpenSearchClient,
} from "./src/config/opensearch.js";
import { requireOwnerSession } from "./src/middleware/ownerAuth.js";
import { createRateLimiters } from "./src/middleware/rateLimits.js";

import chatRouter from "./src/routes/chat.js";
import healthRouter from "./src/routes/health.js";
import memoryRouter from "./src/routes/memoryRouter.js";
import cloudRouter from "./src/routes/cloudRouter.js";
import githubRouter from "./src/routes/githubRouter.js";
import calendarRouter from "./src/routes/calendarRouter.js";
import permissionsRouter from "./src/routes/permissionsRouter.js";
import googleDriveRouter from "./src/routes/googleDriveRouter.js";
import githubOAuthRouter from "./src/routes/githubOAuthRouter.js";
import webSearchRouter from "./src/routes/webSearchRouter.js";
import publicConfigRouter from "./src/routes/publicConfigRouter.js";
import mcpRouter from "./src/routes/mcpRouter.js";

dotenv.config();

const { oauthRateLimiter, paidAiRateLimiter, privateApiRateLimiter } =
  createRateLimiters();

if (!process.env.AGENT_KEY) {
  console.warn(
    "⚠️  AGENT_KEY is not configured. Direct AI conversation is unavailable; independent tools can still run.",
  );
}

const app = express();

app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use((_req, res, next) => {
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "script-src 'self' https://cdn.jsdelivr.net",
      "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
      "img-src 'self' data: https:",
      "connect-src 'self'",
      "font-src 'self' data: https://cdnjs.cloudflare.com",
      "media-src 'self'",
      "worker-src 'self'",
      "manifest-src 'self'",
    ].join("; "),
  );
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  );
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  next();
});
app.use(express.json({ limit: "8mb" }));
app.use(
  express.static("public", {
    maxAge: 0,
    setHeaders(res, filePath) {
      if (/\.(html|js|css)$/.test(filePath)) {
        res.setHeader("Cache-Control", "no-store, max-age=0");
      }
    },
  }),
);

app.use("/health", healthRouter);
app.use("/api/public-config", publicConfigRouter);
app.use("/api/github", oauthRateLimiter, githubOAuthRouter);
app.use("/mcp", privateApiRateLimiter, mcpRouter);

app.use("/chat", requireOwnerSession, paidAiRateLimiter, chatRouter);
app.use("/memory", requireOwnerSession, privateApiRateLimiter, memoryRouter);
app.use("/cloud", requireOwnerSession, privateApiRateLimiter, cloudRouter);
app.use("/github", requireOwnerSession, privateApiRateLimiter, githubRouter);
app.use(
  "/calendar",
  requireOwnerSession,
  privateApiRateLimiter,
  calendarRouter,
);
app.use(
  "/permissions",
  requireOwnerSession,
  privateApiRateLimiter,
  permissionsRouter,
);
app.use(
  "/api/google",
  requireOwnerSession,
  privateApiRateLimiter,
  googleDriveRouter,
);
app.use("/search", requireOwnerSession, paidAiRateLimiter, webSearchRouter);

app.get("/opensearch-status", requireOwnerSession, async (req, res) => {
  const client = getOpenSearchClient();
  if (!client) {
    return res.json({ status: "not-configured" });
  }

  try {
    const health = await client.cluster.health();
    res.json({ status: health.body.status });
  } catch (error) {
    res.status(500).json({ status: "error", error: error.message });
  }
});

app.get("/", (req, res) => {
  res.sendFile(`${process.cwd()}/public/index.html`);
});

if (process.env.NODE_ENV !== "test") {
  createOpenSearchClient();
  startServer();
}

function startServer() {
  const PORT = process.env.PORT || 8080;
  app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
  });
}

export default app;
