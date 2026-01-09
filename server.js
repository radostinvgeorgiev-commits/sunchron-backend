
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createOpenSearchClient, getOpenSearchClient } from "./src/config/opensearch.js";

import chatRouter from "./src/routes/chat.js";
import healthRouter from "./src/routes/health.js";
import memoryRouter from "./src/routes/memoryRouter.js";
import cloudRouter from "./src/routes/cloudRouter.js";

dotenv.config();


const app = express();

/* Middleware */
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

/* Routes */

app.use("/chat", chatRouter);
app.use("/health", healthRouter);
app.use("/memory", memoryRouter);
app.use("/cloud", cloudRouter);

// New Endpoint: OpenSearch Status
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

// Обслужване на началната страница от public/index.html
app.get("/", (req, res) => {
  res.sendFile(process.cwd() + '/public/index.html');
});

/* Start Server */

// Стартиране на сървъра само ако файлът се изпълнява директно
if (process.env.NODE_ENV !== "test") {
  // Инициализиране на OpenSearch клиент
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
