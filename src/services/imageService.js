import { DEFAULT_CLAUDE_CHAT_MODEL, reportAiUsage } from "./aiCoreService.js";
import { publicAiOutputLimit, reservePublicAiFile } from "./publicAiBudget.js";

const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
]);
const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export class ImageServiceError extends Error {
  constructor(message, status = 502, code = "IMAGE_SERVICE_ERROR") {
    super(message);
    this.name = "ImageServiceError";
    this.status = status;
    this.code = code;
  }
}

export function validateImageInput(image) {
  if (!image || typeof image !== "object") {
    throw new ImageServiceError("Липсва валидна снимка.", 400, "INVALID_IMAGE");
  }

  const { dataUrl, mimeType } = image;
  if (
    typeof dataUrl !== "string" ||
    typeof mimeType !== "string" ||
    !ALLOWED_IMAGE_TYPES.has(mimeType)
  ) {
    throw new ImageServiceError(
      "Поддържат се само JPEG, PNG и WebP снимки и PDF документи.",
      415,
      "UNSUPPORTED_IMAGE",
    );
  }

  const prefix = `data:${mimeType};base64,`;
  if (!dataUrl.startsWith(prefix)) {
    throw new ImageServiceError(
      "Снимката е в невалиден формат.",
      400,
      "INVALID_IMAGE",
    );
  }

  const base64 = dataUrl.slice(prefix.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(base64)) {
    throw new ImageServiceError(
      "Снимката е в невалиден формат.",
      400,
      "INVALID_IMAGE",
    );
  }

  const byteLength = Buffer.from(base64, "base64").byteLength;
  if (!byteLength || byteLength > MAX_IMAGE_BYTES) {
    throw new ImageServiceError(
      "Снимката трябва да бъде до 5 MB.",
      413,
      "IMAGE_TOO_LARGE",
    );
  }

  return { dataUrl, mimeType, byteLength };
}

export async function analyzeImage({
  image,
  prompt,
  context,
  fetchImpl = fetch,
  inferenceUrl = process.env.OPENAI_API_URL ||
    "https://api.openai.com/v1/chat/completions",
  modelAccessKey = process.env.OPENAI_API_KEY,
  model = process.env.OPENAI_VISION_MODEL || "gpt-4o-mini",
  claudeAccessKey = process.env.ANTHROPIC_API_KEY,
  claudeModel = process.env.ANTHROPIC_MODEL || DEFAULT_CLAUDE_CHAT_MODEL,
  signal,
}) {
  const validated = validateImageInput(image);
  // Claude reads both pictures and PDF documents; OpenAI vision stays as the
  // fallback for pictures when no Claude key is configured.
  if (claudeAccessKey) {
    return analyzeWithClaude({
      validated,
      prompt,
      context,
      fetchImpl,
      apiKey: claudeAccessKey,
      model: claudeModel,
      signal,
    });
  }
  if (validated.mimeType === "application/pdf") {
    throw new ImageServiceError(
      "Четенето на PDF изисква Claude ключ.",
      503,
      "DOCUMENT_READER_NOT_CONFIGURED",
    );
  }
  if (!modelAccessKey) {
    throw new ImageServiceError(
      "Разпознаването на снимки не е конфигурирано.",
      503,
      "VISION_NOT_CONFIGURED",
    );
  }

  await reservePublicAiFile("openai", model);
  const response = await fetchImpl(inferenceUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${modelAccessKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: [context, prompt].filter(Boolean).join("\n\n"),
            },
            {
              type: "image_url",
              image_url: {
                url: validated.dataUrl,
                detail: "auto",
              },
            },
          ],
        },
      ],
      stream: false,
    }),
    signal,
  });

  if (!response.ok) {
    console.error(`[Vision] Upstream request failed: ${response.status}`);
    throw new ImageServiceError(
      `Разпознаването на снимката върна грешка ${response.status}.`,
      502,
      "VISION_UPSTREAM_ERROR",
    );
  }

  const result = await response.json();
  const content = result.choices?.[0]?.message?.content;
  const text = Array.isArray(content)
    ? content
        .filter((item) => item?.type === "text")
        .map((item) => item.text || "")
        .join("")
        .trim()
    : typeof content === "string"
      ? content.trim()
      : "";

  if (!text) {
    throw new ImageServiceError(
      "Не получих описание на снимката.",
      502,
      "EMPTY_VISION_RESPONSE",
    );
  }

  return text;
}

async function analyzeWithClaude({ validated, prompt, context, fetchImpl, apiKey, model, signal }) {
  const base64 = validated.dataUrl.slice(`data:${validated.mimeType};base64,`.length);
  const isPdf = validated.mimeType === "application/pdf";
  await reservePublicAiFile("claude", model);
  const response = await fetchImpl(ANTHROPIC_MESSAGES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: publicAiOutputLimit() || 2048,
      ...(context ? { system: context } : {}),
      messages: [
        {
          role: "user",
          content: [
            {
              type: isPdf ? "document" : "image",
              source: { type: "base64", media_type: validated.mimeType, data: base64 },
            },
            {
              type: "text",
              text: prompt || (isPdf ? "Обобщи този документ." : "Какво виждаш на тази снимка?"),
            },
          ],
        },
      ],
    }),
    signal,
  });
  if (!response.ok) {
    console.error(`[Claude vision] Upstream request failed: ${response.status}`);
    throw new ImageServiceError(
      `Четенето на ${isPdf ? "документа" : "снимката"} върна грешка ${response.status}.`,
      502,
      "VISION_UPSTREAM_ERROR",
    );
  }
  const data = await response.json();
  const text = Array.isArray(data?.content)
    ? data.content
        .filter((item) => item?.type === "text")
        .map((item) => item.text || "")
        .join("\n")
        .trim()
    : "";
  if (!text) {
    throw new ImageServiceError(
      isPdf ? "Не получих отговор за документа." : "Не получих описание на снимката.",
      502,
      "EMPTY_VISION_RESPONSE",
    );
  }
  reportAiUsage("claude", data?.model || model, data?.usage?.input_tokens, data?.usage?.output_tokens);
  return text;
}
