import express from "express";
import dotenv from "dotenv";
import {
  createOpenSearchClient,
  getOpenSearchClient,
} from "./src/config/opensearch.js";
import {
  requireOwnerSession,
  requirePrimaryOwner,
} from "./src/middleware/ownerAuth.js";
import { createRateLimiters } from "./src/middleware/rateLimits.js";
import { startMemoryStartupVerification } from "./src/services/memoryStartupVerificationService.js";
import { executeCapability } from "./src/tools/capabilityEngine.js";

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
import userAuthRouter from "./src/routes/userAuthRouter.js";
import testerAuthAdminRouter from "./src/routes/testerAuthAdminRouter.js";
import systemRouter from "./src/routes/systemRouter.js";
import workspacesRouter from "./src/routes/workspacesRouter.js";
import mcpRouter from "./src/routes/mcpRouter.js";
import { createMcpOAuthRouter } from "./src/routes/mcpOAuthRouter.js";

dotenv.config();

const { oauthRateLimiter, paidAiRateLimiter, privateApiRateLimiter } =
  createRateLimiters();
const mcpOAuthRouter = createMcpOAuthRouter({ oauthRateLimiter });

if (!process.env.OPENAI_API_KEY) {
  console.warn(
    "⚠️  OPENAI_API_KEY is not configured. Direct AI conversation is unavailable; independent tools can still run.",
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
  res.setHeader(
    "Strict-Transport-Security",
    "max-age=31536000; includeSubDomains",
  );
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

const mobileLayoutAssetVersion = "20260730-v2";
const versionedApplicationAssets = Object.freeze({
  "app.js": "public/app.js",
  "work-center.js": "public/work-center.js",
});
const safeAssetVersionPattern = /^[a-z0-9][a-z0-9._-]{0,79}$/iu;

app.get("/assets/:version/:asset", (req, res, next) => {
  const assetPath = versionedApplicationAssets[req.params.asset];
  if (!safeAssetVersionPattern.test(req.params.version) || !assetPath) {
    next();
    return;
  }

  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.sendFile(`${process.cwd()}/${assetPath}`);
});
app.get(
  `/assets/${mobileLayoutAssetVersion}/synchron-vision.css`,
  (_req, res) => {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.sendFile(`${process.cwd()}/public/synchron-vision.css`);
  },
);
app.get(
  `/assets/${mobileLayoutAssetVersion}/synchron-vision.js`,
  (_req, res) => {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.sendFile(`${process.cwd()}/public/synchron-vision.js`);
  },
);
app.use("/", mcpOAuthRouter);

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
app.use("/api/auth", oauthRateLimiter, userAuthRouter);
app.use("/api/github", oauthRateLimiter, githubOAuthRouter);
app.use("/mcp", privateApiRateLimiter, mcpRouter);

app.use("/chat", requireOwnerSession, paidAiRateLimiter, chatRouter);
app.use("/memory", requireOwnerSession, privateApiRateLimiter, memoryRouter);
app.use(
  "/api/workspaces",
  requireOwnerSession,
  privateApiRateLimiter,
  workspacesRouter,
);
app.use(
  "/api/tester-auth",
  requireOwnerSession,
  requirePrimaryOwner,
  privateApiRateLimiter,
  testerAuthAdminRouter,
);
app.use(
  "/api/system",
  requireOwnerSession,
  requirePrimaryOwner,
  privateApiRateLimiter,
  systemRouter,
);
app.use(
  "/cloud",
  requireOwnerSession,
  requirePrimaryOwner,
  privateApiRateLimiter,
  cloudRouter,
);
app.use(
  "/github",
  requireOwnerSession,
  requirePrimaryOwner,
  privateApiRateLimiter,
  githubRouter,
);
app.use(
  "/calendar",
  requireOwnerSession,
  requirePrimaryOwner,
  privateApiRateLimiter,
  calendarRouter,
);
app.use(
  "/permissions",
  requireOwnerSession,
  requirePrimaryOwner,
  privateApiRateLimiter,
  permissionsRouter,
);
app.use(
  "/api/google",
  requireOwnerSession,
  requirePrimaryOwner,
  privateApiRateLimiter,
  googleDriveRouter,
);
app.use(
  "/search",
  requireOwnerSession,
  requirePrimaryOwner,
  paidAiRateLimiter,
  webSearchRouter,
);

app.get("/opensearch-status", requireOwnerSession, async (req, res) => {
  const client = getOpenSearchClient();
  if (!client) {
    return res.json({ status: "not-configured" });
  }

  try {
    const health = await client.cluster.health();
    res.json({ status: health.body.status });
  } catch {
    console.error("[OpenSearch status] Health check failed.");
    res.status(503).json({
      status: "error",
      code: "OPENSEARCH_UNAVAILABLE",
    });
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
    void startMemoryStartupVerification({
      ownerId: process.env.MEMORY_OWNER_ID || "primary-user",
      verifyDeleteGuard: async ({ fact, scope, ownerId }) => {
        try {
          await executeCapability(
            "memory.delete",
            { fact, scope, ownerId },
            { confirmed: false },
          );
        } catch (error) {
          if (error?.code === "CAPABILITY_CONFIRMATION_REQUIRED") return true;
          throw error;
        }
        return false;
      },
    }).then((status) => {
      const log = status.ready ? console.log : console.error;
      log(
        `[Memory acceptance] status=${status.status} attempts=${status.attempts} cleanup=${status.cleanupCompleted}`,
      );
    });
  });
}

export default app;
