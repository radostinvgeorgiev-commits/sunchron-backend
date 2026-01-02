
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createOpenSearchClient } from "./src/config/opensearch.js";

import chatRouter from "./src/routes/chat.js";
import healthRouter from "./src/routes/health.js";
import memoryRouter from "./src/routes/memoryRouter.js";

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
app.get("/", (req, res) => res.send("OK"));

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
