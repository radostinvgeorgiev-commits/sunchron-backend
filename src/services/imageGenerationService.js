import { reservePublicAiImage } from "./publicAiBudget.js";
import { requestAiResponse } from "./novariumService.js";
import { isVertexAiConfigured, resolveVertexAiModel } from "./vertexAiGeminiService.js";

export const DEFAULT_GEMINI_IMAGE_MODEL = "gemini-2.5-flash-image-preview";

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

export function createImageGenerationService({ env = process.env, fetchImpl = fetch, reserve = reservePublicAiImage, authClient } = {}) {
  async function generate(value) {
    const prompt = cleanImagePrompt(value);
    if (!isVertexAiConfigured(env)) {
      throw new ImageGenerationError("Рисуването не е настроено.", 503, "IMAGE_NOT_CONFIGURED");
    }
    const model = env.GEMINI_IMAGE_MODEL || DEFAULT_GEMINI_IMAGE_MODEL;
    await reserve("vertex-gemini", model);
    try {
      const response = await requestAiResponse({
        provider: "vertex-gemini",
        env,
        model,
        input: [{ role: "user", content: `Създай изображение по това описание:\n${prompt}` }],
        fetchImpl,
        authClient,
        responseModalities: ["TEXT", "IMAGE"],
      });
      if (!response?.imageBase64) {
        throw new ImageGenerationError("Картинката не стана. Опитай пак.");
      }
      return { image: `data:image/png;base64,${response.imageBase64}`, prompt, model: response.model || model };
    } catch (error) {
      if (error instanceof ImageGenerationError) throw error;
      throw new ImageGenerationError("Картинката не стана. Опитай пак.");
    }
  }
  return { generate };
}

let defaultService;
export function getImageGenerationService() {
  return (defaultService ||= createImageGenerationService());
}
