import express from "express";

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
      return res.status(502).json({ error: "AI търсенето временно не е достъпно." });
    }

    const result = extractSearchResult(await response.json());
    if (!result.text) {
      return res.status(502).json({ error: "Търсенето не върна отговор." });
    }
    return res.json(result);
  } catch (error) {
    console.error("[Web search] Failure:", error);
    return res.status(502).json({ error: "AI търсенето беше прекъснато. Опитай пак." });
  }
});

export { extractSearchResult };
export default router;
