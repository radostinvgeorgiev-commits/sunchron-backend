import { reservePublicAiImage } from "./publicAiBudget.js";

// "Нарисувай": first with Google's image model, then OpenAI as fallback when
// only a personal OpenAI key is connected.
export const DEFAULT_GEMINI_IMAGE_MODEL = "gemini-2.5-flash-image-preview";
export const DEFAULT_OPENAI_IMAGE_MODEL = "gpt-image-1-mini";

export class ImageGenerationError extends Error {
  constructor(message, status = 502, code = "IMAGE_GENERATION_FAILED") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function cleanImagePrompt(value) {
  const prompt = String(value || "").replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  if (prompt.length < 3) throw new ImageGenerationError("Опиши какво да нарисувам.", 400, "IMAGE_PROMPT_EMPTY");
  return prompt.slice(0, 1500);
}

export function createImageGenerationService({ env = process.env, fetchImpl = fetch, reserve = reservePublicAiImage } = {}) {
  async function generate(value) {
    const prompt = cleanImagePrompt(value);
    if (!env.GEMINI_API_KEY && !env.OPENAI_API_KEY) {
      throw new ImageGenerationError("Рисуването не е настроено.", 503, "IMAGE_NOT_CONFIGURED");
    }
    if (env.GEMINI_API_KEY) {
      const model = env.GEMINI_IMAGE_MODEL || DEFAULT_GEMINI_IMAGE_MODEL;
      await reserve("gemini", model);
      const response = await fetchImpl(
        `${String(env.GEMINI_API_URL || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/u, "")}/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
          body: JSON.stringify({
            contents: [
              {
                role: "user",
                parts: [{ text: `Създай изображение по това описание:\n${prompt}` }],
              },
            ],
            generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
          }),
        },
      );
      const data = await response.json().catch(() => ({}));
      if (response.ok) {
        const base64 = (data?.candidates?.[0]?.content?.parts || []).find((part) => part?.inlineData?.data)?.inlineData?.data;
        if (base64) return { image: `data:image/png;base64,${base64}`, prompt, model };
      }
      if (!env.OPENAI_API_KEY) {
        throw new ImageGenerationError("Картинката не стана. Опитай пак.");
      }
    }
    const model = env.OPENAI_IMAGE_MODEL || DEFAULT_OPENAI_IMAGE_MODEL;
    await reserve("openai", model);
    const response = await fetchImpl("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model,
        prompt,
        n: 1,
        size: "1024x1024",
        quality: "medium",
        output_format: "webp",
        output_compression: 80,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const refused = response.status === 400 && /safety|moderation|policy/iu.test(JSON.stringify(data?.error || ""));
      throw refused
        ? new ImageGenerationError("Не мога да нарисувам това. Опитай с друго описание.", 400, "IMAGE_REFUSED")
        : new ImageGenerationError("Картинката не стана. Опитай пак.");
    }
    const base64 = data?.data?.[0]?.b64_json;
    if (!base64) throw new ImageGenerationError("Картинката не стана. Опитай пак.");
    return { image: `data:image/webp;base64,${base64}`, prompt, model };
  }
  return { generate };
}

let defaultService;
export function getImageGenerationService() {
  return (defaultService ||= createImageGenerationService());
}
