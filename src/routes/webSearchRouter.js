import express from "express";
import { auditIntegrationEvent } from "../services/auditService.js";
import { evaluatePermission } from "../services/permissionService.js";

const router = express.Router();
const DEFAULT_MODEL = "gpt-4.1-mini";
const MAX_QUERY_LENGTH = 1500;

function extractSearchResult(response) {
  const message = Array.isArray(response?.output)
    ? response.output.find((item) => item?.type === "message")
    : null;
  const content = Array.isArray(message?.content)
    ? message.content.find((item) => item?.type === "output_text")
    : null;
  const text = typeof content?.text === "string" ? content.text.trim() : "";
  const sources = [];
  const seen = new Set();

  for (const annotation of content?.annotations || []) {
    if (annotation?.type !== "url_citation" || !annotation.url) continue;
    if (seen.has(annotation.url)) continue;
    seen.add(annotation.url);
    sources.push({
      title: annotation.title || annotation.url,
      url: annotation.url,
    });
  }
  return { text, sources };
}

router.post("/ai", async (req, res) => {
  const permission = evaluatePermission("web.read");
  if (permission.decision !== "allow") {
    await auditIntegrationEvent(
      {
        action: "web.read",
        decision: permission.decision,
        outcome: "blocked",
        resource: "POST /search/ai",
        details: permission.reason,
      },
      "Web search audit",
    );
    return res.status(403).json({ error: permission.reason });
  }

  const query = typeof req.body?.query === "string" ? req.body.query.trim() : "";
  if (!query) return res.status(400).json({ error: "Напиши какво да потърся." });
  if (query.length > MAX_QUERY_LENGTH) {
    return res.status(400).json({ error: "Търсенето е прекалено дълго." });
  }
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: "AI търсенето още не е конфигурирано." });
  }

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.WEB_SEARCH_MODEL || DEFAULT_MODEL,
        tools: [{ type: "web_search", search_context_size: "medium" }],
        tool_choice: "required",
        input: [
          "Отговори на български език.",
          "Направи актуално интернет търсене и дай ясен, практичен отговор.",
          "Не измисляй факти. Използвай видими и проверими източници.",
          "",
          query,
        ].join("\n"),
      }),
      signal: AbortSignal.timeout(60000),
    });

    if (!response.ok) {
      const body = await response.text();
      console.error("[Web search] OpenAI error:", response.status, body);
      await auditIntegrationEvent(
        {
          action: "web.read",
          decision: permission.decision,
          outcome: "failed",
          resource: "POST /search/ai",
          details: `OPENAI_HTTP_${response.status}`,
        },
        "Web search audit",
      );
      return res.status(502).json({ error: "AI търсенето временно не е достъпно." });
    }

    const result = extractSearchResult(await response.json());
    if (!result.text) {
      await auditIntegrationEvent(
        {
          action: "web.read",
          decision: permission.decision,
          outcome: "failed",
          resource: "POST /search/ai",
          details: "EMPTY_RESULT",
        },
        "Web search audit",
      );
      return res.status(502).json({ error: "Търсенето не върна отговор." });
    }
    await auditIntegrationEvent(
      {
        action: "web.read",
        decision: permission.decision,
        outcome: "succeeded",
        resource: "POST /search/ai",
      },
      "Web search audit",
    );
    return res.json(result);
  } catch (error) {
    console.error("[Web search] Failure:", error);
    await auditIntegrationEvent(
      {
        action: "web.read",
        decision: permission.decision,
        outcome: "failed",
        resource: "POST /search/ai",
        details: error?.name || "REQUEST_FAILED",
      },
      "Web search audit",
    );
    return res.status(502).json({ error: "AI търсенето беше прекъснато. Опитай пак." });
  }
});

export { extractSearchResult };
export default router;
