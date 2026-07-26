const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);
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
      "Поддържат се само JPEG, PNG и WebP снимки.",
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
  apiKey = process.env.OPENAI_API_KEY,
  model = process.env.OPENAI_VISION_MODEL || "gpt-4o-mini",
  signal,
}) {
  const validated = validateImageInput(image);
  if (!apiKey) {
    throw new ImageServiceError(
      "Разпознаването на снимки не е конфигурирано.",
      503,
      "VISION_NOT_CONFIGURED",
    );
  }

  const response = await fetchImpl("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: [context, prompt].filter(Boolean).join("\n\n"),
            },
            {
              type: "input_image",
              image_url: validated.dataUrl,
              detail: "auto",
            },
          ],
        },
      ],
    }),
    signal,
  });

  if (!response.ok) {
    const body = await response.text();
    console.error(`[Vision] ${response.status}:`, body || "<empty>");
    throw new ImageServiceError(
      `Разпознаването на снимката върна грешка ${response.status}.`,
      502,
      "VISION_UPSTREAM_ERROR",
    );
  }

  const result = await response.json();
  const text =
    typeof result.output_text === "string"
      ? result.output_text.trim()
      : result.output
          ?.flatMap((item) => item.content || [])
          .filter((item) => item.type === "output_text")
          .map((item) => item.text)
          .join("")
          .trim();

  if (!text) {
    throw new ImageServiceError(
      "Не получих описание на снимката.",
      502,
      "EMPTY_VISION_RESPONSE",
    );
  }

  return text;
}
