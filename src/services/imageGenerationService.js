import { reservePublicAiImage } from "./publicAiBudget.js";

// "Нарисувай": a picture from a text description. GPT Image 1 Mini at medium
// quality costs about $0.011 for 1024x1024; WebP keeps the picture small.
export const DEFAULT_IMAGE_MODEL = "gpt-image-1-mini";

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
    if (!env.OPENAI_API_KEY) throw new ImageGenerationError("Рисуването не е настроено.", 503, "IMAGE_NOT_CONFIGURED");
    const model = env.OPENAI_IMAGE_MODEL || DEFAULT_IMAGE_MODEL;
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
