import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import {
  createOpenSearchClient,
  getOpenSearchClient,
} from "./src/config/opensearch.js";
import { requireOwnerSession } from "./src/middleware/ownerAuth.js";

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

dotenv.config();

if (!process.env.AGENT_KEY) {
  console.warn(
    "⚠️  AGENT_KEY is not configured. Direct AI conversation is unavailable; independent tools can still run.",
  );
}

const app = express();

app.use(cors());
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
app.use("/api/github", githubOAuthRouter);

app.use(requireOwnerSession);

app.use("/chat", chatRouter);
app.use("/memory", memoryRouter);
app.use("/cloud", cloudRouter);
app.use("/github", githubRouter);
app.use("/calendar", calendarRouter);
app.use("/permissions", permissionsRouter);
app.use("/api/google", googleDriveRouter);
app.use("/search", webSearchRouter);

app.get("/opensearch-status", async (req, res) => {
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
