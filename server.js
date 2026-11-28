import { publicAiBudgetContext } from "./src/services/publicAiBudget.js";
import express from "express";
import {
  createProductRouter,
  productWebhook,
} from "./src/routes/productRouter.js";
import {
  requireOwnerSession,
  requirePrimaryOwner,
} from "./src/middleware/ownerAuth.js";
import {
  createApiRateLimiter,
  createRateLimiters,
} from "./src/middleware/rateLimits.js";
import { startMemoryStartupVerification } from "./src/services/memoryStartupVerificationService.js";
import { executeCapability } from "./src/tools/capabilityEngine.js";
import {
  getAiProviderStatus,
  setAiUsageRecorder,
} from "./src/services/novariumService.js";
import { getAiSpendService } from "./src/services/aiSpendService.js";
import createAiSpendRouter from "./src/routes/aiSpendRouter.js";
import {
  logCampaignEvent,
  readCampaignAttribution,
} from "./src/services/campaignAttribution.js";

import chatRouter from "./src/routes/chat.js";
import healthRouter from "./src/routes/health.js";
import { checkCoreTools } from "./src/services/toolLiveCheckService.js";
import { summarizeRegisteredAccounts } from "./src/services/registeredAccountsService.js";
import memoryRouter from "./src/routes/memoryRouter.js";
import cloudRouter from "./src/routes/cloudRouter.js";
import githubRouter from "./src/routes/githubRouter.js";
import codeWorkspaceRouter from "./src/routes/codeWorkspaceRouter.js";
import calendarRouter from "./src/routes/calendarRouter.js";
import permissionsRouter from "./src/routes/permissionsRouter.js";
import connectionsRouter from "./src/routes/connectionsRouter.js";
import memoryInboxRouter from "./src/routes/memoryInboxRouter.js";
import accountRouter from "./src/routes/accountRouter.js";
import googleDriveRouter from "./src/routes/googleDriveRouter.js";
import githubOAuthRouter from "./src/routes/githubOAuthRouter.js";
import webSearchRouter from "./src/routes/webSearchRouter.js";
import publicConfigRouter from "./src/routes/publicConfigRouter.js";
import userAuthRouter, { handleGoogleSignInCallback } from "./src/routes/userAuthRouter.js";
import { startOnCallbackOrigin } from "./src/middleware/startOnCallbackOrigin.js";
import { returnToConnectStart } from "./src/middleware/returnToConnectStart.js";
import { isGoogleSignInCallback } from "./src/services/googleSignInService.js";
import { getActivityService } from "./src/services/activityService.js";
import { logSafeError } from "./src/utils/safeLogging.js";
import testerAuthAdminRouter from "./src/routes/testerAuthAdminRouter.js";
import systemRouter from "./src/routes/systemRouter.js";
import workspacesRouter from "./src/routes/workspacesRouter.js";
import tasksRouter from "./src/routes/tasksRouter.js";
import taskRunsRouter from "./src/routes/taskRunsRouter.js";
import { createShareRouter, createSharedReadRouter } from "./src/routes/shareRouter.js";
import { createShareService } from "./src/services/shareService.js";
import createVoiceRouter from "./src/routes/voiceRouter.js";
import { createFeedbackRouter } from "./src/routes/feedbackRouter.js";
import { createUserLibraryRouter } from "./src/routes/userLibraryRouter.js";
import { createAvatarProfileRouter } from "./src/routes/avatarProfileRouter.js";
import { createCausesRouter } from "./src/routes/causesRouter.js";
import { createDailyPlanRouter } from "./src/routes/dailyPlanRouter.js";
import { createImageGenerationRouter } from "./src/routes/imageGenerationRouter.js";
import { getImageGenerationService } from "./src/services/imageGenerationService.js";
import { createVideoGenerationRouter } from "./src/routes/videoGenerationRouter.js";
import { getVideoGenerationService } from "./src/services/videoGenerationService.js";
import { createClaudeWorkRouter } from "./src/routes/claudeWorkRouter.js";
import { getClaudeWorkService } from "./src/services/claudeWorkService.js";
import { getDailyPlanService } from "./src/services/dailyPlanService.js";
import { getCausesService } from "./src/services/causesService.js";
import { getAvatarProfileService } from "./src/services/avatarProfileService.js";
import { createPersonalTodoRouter } from "./src/routes/personalTodoRouter.js";
import { createBookMemoryRouter } from "./src/routes/bookMemoryRouter.js";
import { createFreeChapterCheckRouter } from "./src/routes/freeChapterCheckRouter.js";
import { createAddonRouter } from "./src/routes/addonRouter.js";
import { createAvatarLinkRouter, createAvatarVisitorRouter } from "./src/routes/avatarLinkRouter.js";
import { getAvatarLinkService } from "./src/services/avatarLinkService.js";
import { getPersonalTodoService } from "./src/services/personalTodoService.js";
import { getBookMemoryService } from "./src/services/bookMemoryService.js";
import { getFreeChapterCheck } from "./src/services/freeChapterCheckService.js";
import { getAddonService } from "./src/services/addonService.js";
import { createKnowledgeFilesRouter } from "./src/routes/knowledgeFilesRouter.js";
import { getKnowledgeFilesService } from "./src/services/knowledgeFilesService.js";
import { getUserLibraryService } from "./src/services/userLibraryService.js";
import { createFeedbackService } from "./src/services/feedbackService.js";
import { listConversationMessages } from "./src/services/memoryService.js";
import {
  createEarlyAccessAdminRouter,
  createEarlyAccessRouter,
} from "./src/routes/earlyAccessRouter.js";
import {
  createContactAdminRouter,
  createContactRouter,
} from "./src/routes/contactRouter.js";
import mcpRouter, { mcpJsonParseErrorHandler } from "./src/routes/mcpRouter.js";
import { createChatGptMcpRouter, getChatGptMcpResourceMetadata } from "./src/routes/chatGptMcpRouter.js";
import { createMcpOAuthRouter } from "./src/routes/mcpOAuthRouter.js";

const { oauthRateLimiter, paidAiRateLimiter, privateApiRateLimiter } =
  createRateLimiters();
const mcpOAuthRouter = createMcpOAuthRouter({ oauthRateLimiter });

const aiProviderStatus = getAiProviderStatus(process.env);
if (!aiProviderStatus.configured) {
  console.warn(
    `⚠️  NovariumAI provider ${aiProviderStatus.selectedProvider ?? "unknown"} is not configured. Direct AI conversation is unavailable; independent tools can still run.`,
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
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "connect-src 'self'",
      "font-src 'self' data:",
      "media-src 'self' blob:",
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
    // Voice input in the chat needs the microphone on this site only.
    "camera=(), microphone=(self), geolocation=(), payment=(), usb=()",
  );
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  next();
});
app.post(
  "/api/product/webhook",
  express.raw({ type: "application/json", limit: "128kb" }),
  productWebhook,
);
app.use(express.json({ limit: "8mb" }));
app.use("/api/product", createProductRouter());

const mobileLayoutAssetVersion = "20260806-green-chat-v1";
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
  res.sendFile(assetPath, { root: process.cwd() });
});
app.get(
  `/assets/${mobileLayoutAssetVersion}/synchron-vision.css`,
  (_req, res) => {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.sendFile("public/synchron-vision.css", { root: process.cwd() });
  },
);
app.get(
  `/assets/${mobileLayoutAssetVersion}/synchron-vision.js`,
  (_req, res) => {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.sendFile("public/synchron-vision.js", { root: process.cwd() });
  },
);
app.use("/", mcpOAuthRouter);
// A sign-in starts on the name its provider returns to
// (src/middleware/startOnCallbackOrigin.js); a connect finishes on the name
// where it was pressed (src/middleware/returnToConnectStart.js).
app.use(startOnCallbackOrigin());

app.use(
  express.static("public", {
    maxAge: 0,
    setHeaders(res, filePath) {
      if (/\.(html|js|mjs|css)$/.test(filePath)) {
        res.setHeader("Cache-Control", "no-store, max-age=0");
      }
    },
  }),
);

app.use("/health", healthRouter);
app.use("/api/public-config", publicConfigRouter);
app.use("/api/auth", oauthRateLimiter, userAuthRouter);
app.use(
  "/api/early-access",
  createApiRateLimiter({ limit: 10 }),
  createEarlyAccessRouter(),
);
app.use(
  "/admin/early-access",
  requireOwnerSession,
  requirePrimaryOwner,
  privateApiRateLimiter,
  createEarlyAccessAdminRouter(),
);
// The contact form on /help (manifesto §5: people reach us only through the
// site). It limits itself and answers with a page, not JSON.
app.use("/api/contact", createContactRouter());
app.use(
  "/admin/contact",
  requireOwnerSession,
  requirePrimaryOwner,
  privateApiRateLimiter,
  createContactAdminRouter(),
);
// The owner's „Активност“ page: daily counts only, no personal data.
app.get(
  "/api/activity",
  requireOwnerSession,
  requirePrimaryOwner,
  privateApiRateLimiter,
  async (req, res) => {
    try {
      const [days, accounts] = await Promise.all([
        getActivityService().summary(req.query.days),
        summarizeRegisteredAccounts({ ownerEmail: req.owner?.email }),
      ]);
      // New accounts per day come from the sign-in provider when it can be
      // read, so people from before the counters started are counted too.
      const merged = accounts.available
        ? days.map((day) => ({ ...day, registrations: Math.max(Number(day.registrations) || 0, accounts.byDay[day.date] || 0) }))
        : days;
      res.json({
        days: merged,
        accounts: accounts.available
          ? {
            total: accounts.total,
            signedInLast7Days: accounts.signedInLast7Days,
            ...(Number.isInteger(accounts.ownerAccounts)
              ? { ownerAccounts: accounts.ownerAccounts, otherAccounts: accounts.otherAccounts }
              : {}),
          }
          : { error: accounts.reason },
      });
    } catch (error) {
      logSafeError("[Activity] summary", error);
      res.status(503).json({ error: "Активността временно не е достъпна." });
    }
  },
);
// What the owner's tools list showed as not working, so Claude can read it in
// the runtime logs instead of asking the owner for a screenshot. Only tool
// names, badge text and short reasons; no personal data.
const clip = (value, max) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, max);
app.post(
  "/api/tools/report",
  requireOwnerSession,
  requirePrimaryOwner,
  privateApiRateLimiter,
  (req, res) => {
    const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 40) : [];
    for (const item of items) {
      console.warn(`[Tools] not working: ${clip(item?.name, 60)} — ${clip(item?.label, 60)} — ${clip(item?.reason, 160)}`);
    }
    res.status(204).end();
  },
);
// Real read-only checks for the owner's tools list (see toolLiveCheckService).
app.get(
  "/api/tools/check",
  requireOwnerSession,
  requirePrimaryOwner,
  privateApiRateLimiter,
  async (req, res) => {
    try {
      res.set("Cache-Control", "no-store");
      res.json({
        checkedAt: new Date().toISOString(),
        tools: await checkCoreTools({ ownerId: req.owner?.memoryOwnerId || "" }),
      });
    } catch (error) {
      logSafeError("[Tools] check", error);
      res.status(503).json({ error: "Проверката временно не е достъпна." });
    }
  },
);
app.use("/api/github", oauthRateLimiter, githubOAuthRouter);
const chatGptMcpRouter = createChatGptMcpRouter();
app.use("/mcp/chatgpt", mcpJsonParseErrorHandler, privateApiRateLimiter, chatGptMcpRouter);
app.get("/.well-known/oauth-protected-resource/mcp/chatgpt", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(getChatGptMcpResourceMetadata());
});
app.use("/mcp", mcpJsonParseErrorHandler, privateApiRateLimiter, mcpRouter);

app.use(
  "/chat",
  requireOwnerSession,
  paidAiRateLimiter,
  publicAiBudgetContext,
  chatRouter,
);
app.use(
  "/api/knowledge-files",
  requireOwnerSession,
  paidAiRateLimiter,
  publicAiBudgetContext,
  createKnowledgeFilesRouter({ service: getKnowledgeFilesService() }),
);
app.use(
  "/api/library",
  requireOwnerSession,
  privateApiRateLimiter,
  createUserLibraryRouter({ service: getUserLibraryService() }),
);
app.use(
  "/api/images",
  requireOwnerSession,
  paidAiRateLimiter,
  createImageGenerationRouter({ service: getImageGenerationService() }),
);
app.use(
  "/api/videos",
  requireOwnerSession,
  paidAiRateLimiter,
  createVideoGenerationRouter({ service: getVideoGenerationService() }),
);
// "Работа с Claude": a bigger task for Claude with Anthropic's skills
// (presentation, Word, Excel, PDF) and web search; files come back.
app.use(
  "/api/claude-work",
  requireOwnerSession,
  paidAiRateLimiter,
  createClaudeWorkRouter({ service: getClaudeWorkService(), addons: getAddonService() }),
);
app.use(
  "/api/daily-plan",
  requireOwnerSession,
  paidAiRateLimiter,
  createDailyPlanRouter({ service: getDailyPlanService() }),
);
app.use(
  "/api/causes",
  requireOwnerSession,
  privateApiRateLimiter,
  createCausesRouter({ service: getCausesService() }),
);
app.use(
  "/api/avatar-profile",
  requireOwnerSession,
  privateApiRateLimiter,
  createAvatarProfileRouter({ service: getAvatarProfileService() }),
);
// "Моите задачи": turning a note into tasks is an AI request, so it gets the
// paid limit; the list itself is ordinary private data.
app.use("/api/todos/from-note", requireOwnerSession, paidAiRateLimiter);
app.use(
  "/api/todos",
  requireOwnerSession,
  privateApiRateLimiter,
  createPersonalTodoRouter({ service: getPersonalTodoService() }),
);
// "Писател": the memory of each person's books. Suggesting facts and
// checking a chapter are AI requests, so they get the paid limit.
app.use(/^\/api\/books\/[^/]+\/(?:suggest|check|draft)$/u, requireOwnerSession, paidAiRateLimiter);
app.use(
  "/api/books",
  requireOwnerSession,
  privateApiRateLimiter,
  createBookMemoryRouter({ service: getBookMemoryService() }),
);
// The free chapter check on the start page: no sign-in, three a day for
// each address and a daily total for the whole site.
app.use(
  "/api/free-check",
  createApiRateLimiter({
    limit: 3,
    windowMs: 24 * 60 * 60 * 1000,
    code: "FREE_CHECK_LIMIT",
    message: "Безплатната проверка е до 3 пъти на ден. Влез безплатно, за да проверяваш още.",
  }),
  createFreeChapterCheckRouter({ service: getFreeChapterCheck() }),
);
// "Добавки": each person's own small programs, run in a closed sandbox; the
// store shows only what the owner approved. No AI is used, so no AI budget.
app.use(
  "/api/addons",
  requireOwnerSession,
  privateApiRateLimiter,
  createAddonRouter({ service: getAddonService() }),
);
app.use(
  "/api/feedback",
  requireOwnerSession,
  privateApiRateLimiter,
  createFeedbackRouter({ service: createFeedbackService() }),
);
app.use(
  "/api/voice",
  requireOwnerSession,
  paidAiRateLimiter,
  publicAiBudgetContext,
  createVoiceRouter(),
);
app.use(
  "/api/ai-spend",
  requireOwnerSession,
  requirePrimaryOwner,
  privateApiRateLimiter,
  createAiSpendRouter(),
);
app.use(
  "/api/code-workspace",
  requireOwnerSession,
  requirePrimaryOwner,
  paidAiRateLimiter,
  codeWorkspaceRouter,
);
app.use("/memory", requireOwnerSession, privateApiRateLimiter, memoryRouter);
const shareService = createShareService({
  listMessages: (sessionId, ownerId) =>
    listConversationMessages(sessionId, undefined, ownerId),
});
app.use(
  "/api/share",
  requireOwnerSession,
  privateApiRateLimiter,
  createShareRouter({ service: shareService }),
);
app.use(
  "/api/shared",
  createApiRateLimiter({ limit: 60 }),
  createSharedReadRouter({ service: shareService }),
);
app.get("/status", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.sendFile("status.html", { root: "public" });
});
// "Питай моя аватар": the person's own link, and the public visitor side.
// Visitors are limited per address here and per link per day in the service.
app.use(
  "/api/avatar-link",
  requireOwnerSession,
  privateApiRateLimiter,
  createAvatarLinkRouter({ service: getAvatarLinkService() }),
);
app.use(
  "/api/avatar-visit",
  createApiRateLimiter({ limit: 30, code: "AVATAR_VISIT_RATE_LIMIT" }),
  createAvatarVisitorRouter({ service: getAvatarLinkService() }),
);
app.get("/a/:token", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.sendFile("avatar.html", { root: "public" });
});
app.get("/s/:token", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.sendFile("shared.html", { root: "public" });
});
app.use(
  "/api/workspaces",
  requireOwnerSession,
  privateApiRateLimiter,
  workspacesRouter,
);
app.use(
  "/api/account",
  requireOwnerSession,
  privateApiRateLimiter,
  accountRouter,
);
app.use(
  "/api/memory-inbox",
  requireOwnerSession,
  privateApiRateLimiter,
  memoryInboxRouter,
);
app.use(
  "/api/connections",
  requireOwnerSession,
  privateApiRateLimiter,
  connectionsRouter,
);
app.use("/api/tasks", requireOwnerSession, privateApiRateLimiter, tasksRouter);
app.use(
  "/api/task-runs",
  requireOwnerSession,
  privateApiRateLimiter,
  taskRunsRouter,
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
// Sign-in with Google shares the Drive redirect address; a callback whose
// state matches the sign-in cookie is a sign-in and needs no session yet.
app.get(
  "/api/google/callback",
  oauthRateLimiter,
  (req, res, next) =>
    isGoogleSignInCallback({ state: req.query.state, cookieHeader: req.headers.cookie })
      ? handleGoogleSignInCallback(req, res)
      : next(),
  // A connect pressed on the site's other name finishes there, before this
  // name asks for its own session (src/middleware/returnToConnectStart.js).
  returnToConnectStart({ path: "/api/google/callback", cookie: "synchron_google_state" }),
);
// Every account connects its own Google; owner-only parts are guarded inside.
app.use(
  "/api/google",
  requireOwnerSession,
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

app.get("/", (_req, res) => {
  res.sendFile("public/index.html", { root: process.cwd() });
});

app.get("/developers", (_req, res) =>
  res.sendFile("public/developers.html", { root: process.cwd() }),
);
app.get("/privacy", (_req, res) =>
  res.sendFile("public/privacy.html", { root: process.cwd() }),
);
app.get("/terms", (_req, res) =>
  res.sendFile("public/terms.html", { root: process.cwd() }),
);
app.get("/cookies", (_req, res) =>
  res.sendFile("public/cookies.html", { root: process.cwd() }),
);
app.get("/data-deletion", (_req, res) =>
  res.sendFile("public/data-deletion.html", { root: process.cwd() }),
);
app.get("/transparency", (_req, res) =>
  res.sendFile("public/transparency.html", { root: process.cwd() }),
);
app.get("/help", (_req, res) =>
  res.sendFile("public/help.html", { root: process.cwd() }),
);
app.get("/plans", (req, res) => {
  if (req.method === "GET" && !req.query.request) {
    logCampaignEvent("campaign_landing", readCampaignAttribution(req.query));
  }
  res.sendFile("public/plans.html", { root: process.cwd() });
});

app.get("/register", (_req, res) => {
  res.sendFile("public/index.html", { root: process.cwd() });
});

if (process.env.NODE_ENV !== "test") {
  setAiUsageRecorder((usage) => getAiSpendService().record(usage));
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
