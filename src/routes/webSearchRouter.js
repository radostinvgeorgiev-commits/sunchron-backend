import express from "express";
import {
  extractSearchResult,
  searchWeb,
  WebSearchError,
} from "../services/webSearchService.js";
import { logSafeError } from "../utils/safeLogging.js";

const router = express.Router();

router.post("/ai", async (req, res) => {
  const query =
    typeof req.body?.query === "string" ? req.body.query.trim() : "";
  try {
    return res.json(await searchWeb(query));
  } catch (error) {
    logSafeError("[Web search] Failure", error);
    const status = error instanceof WebSearchError ? error.status : 502;
    return res.status(status).json({
      error:
        error instanceof WebSearchError
          ? error.message
          : "Интернет търсенето беше прекъснато. Опитай пак.",
    });
  }
});

export { extractSearchResult };
export default router;
