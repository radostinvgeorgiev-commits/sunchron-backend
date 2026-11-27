import { reservePublicAiVideo } from "./publicAiBudget.js";
import { logSafeError } from "../utils/safeLogging.js";

// "Направи видео": a short clip (ads and other) from a text description.
// Gemini Omni Flash through the Gemini API key that AI CORE already uses.
// It makes up to about 10 seconds of 720p video with sound, about
// 0.10 US dollars a second, so a member pays a fixed 100 units.
export const DEFAULT_VIDEO_MODEL = "gemini-omni-1.1-flash";
const API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const POLL_INTERVAL_MS = 5_000;
// Cloud Run ends a request after 300 seconds; stop a little earlier.
const TOTAL_TIMEOUT_MS = 270_000;
const MAX_VIDEO_BYTES = 40 * 1024 * 1024;

export class VideoGenerationError extends Error {
  constructor(message, status = 502, code = "VIDEO_GENERATION_FAILED") {
    super(message);
    this.name = "VideoGenerationError";
    this.status = status;
    this.code = code;
  }
}

export function cleanVideoPrompt(value) {
  const prompt = String(value || "").replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  if (prompt.length < 3) throw new VideoGenerationError("Опиши какво видео да направя.", 400, "VIDEO_PROMPT_EMPTY");
  return prompt.slice(0, 2000);
}

// Vertical (9:16) for phone formats such as Reels, TikTok, Shorts or Stories;
// horizontal (16:9) otherwise. An explicit choice from the page wins.
export function pickAspectRatio(prompt, requested) {
  if (requested === "9:16" || requested === "16:9") return requested;
  return /9\s*:\s*16|вертикал|телефон|сторис|stor(y|ies)|reels?|рийл|tik\s*tok|тикток|shorts|шортс|portrait|vertical/iu.test(prompt)
    ? "9:16"
    : "16:9";
}

// The reason is only an HTTP status and Google's status word (for example
// "404 NOT_FOUND"), never a key or the provider's free text.
const failed = (reason = "") =>
  new VideoGenerationError(`Видеото не стана${reason ? ` (Gemini: ${reason})` : ""}. Опитай пак. Единиците са върнати.`);
const refused = () =>
  new VideoGenerationError("Не мога да направя такова видео. Опитай с друго описание. Единиците са върнати.", 400, "VIDEO_REFUSED");

function findVideo(interaction) {
  for (const step of interaction?.steps || []) {
    for (const part of step?.content || []) {
      if (part?.type === "video" && (part.data || part.uri)) return part;
    }
  }
  return null;
}

export function createVideoGenerationService({
  env = process.env,
  fetchImpl = fetch,
  reserve = reservePublicAiVideo,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
} = {}) {
  const headers = () => ({ "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY });

  async function readJson(response) {
    const data = await response.json().catch(() => ({}));
    if (response.ok) return data;
    const text = JSON.stringify(data?.error || data || "");
    const upstream = String(data?.error?.status || "").match(/^[A-Z][A-Z0-9_]{1,63}$/u)?.[0] || "";
    const reason = `${response.status}${upstream ? ` ${upstream}` : ""}`;
    logSafeError(
      "[Video generation] Gemini refused",
      Object.assign(new Error("Gemini video request failed"), { status: response.status, upstreamErrorStatus: upstream || undefined }),
    );
    if (response.status === 400 && /safety|policy|block|prohibit|harm/iu.test(text)) throw refused();
    throw failed(reason);
  }

  async function download(part) {
    if (part.data) {
      const bytes = Buffer.from(part.data, "base64");
      if (!bytes.length) throw failed();
      return bytes;
    }
    const url = new URL(part.uri);
    if (url.protocol !== "https:" || url.hostname !== "generativelanguage.googleapis.com") throw failed();
    if (!/[:?&]alt=media/u.test(url.href)) {
      if (!url.pathname.endsWith(":download")) url.pathname += ":download";
      url.searchParams.set("alt", "media");
    }
    const response = await fetchImpl(url.href, { headers: { "x-goog-api-key": env.GEMINI_API_KEY } });
    if (!response.ok) throw failed(`download ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_VIDEO_BYTES) throw failed();
    return bytes;
  }

  async function generate(value, options = {}) {
    const prompt = cleanVideoPrompt(value);
    if (!env.GEMINI_API_KEY) throw new VideoGenerationError("Видеата не са настроени.", 503, "VIDEO_NOT_CONFIGURED");
    const model = env.GEMINI_OMNI_VIDEO_MODEL || DEFAULT_VIDEO_MODEL;
    const aspectRatio = pickAspectRatio(prompt, options.aspectRatio);
    const giveBack = await reserve("gemini", model);
    try {
      const started = now();
      let interaction = await readJson(
        await fetchImpl(`${API_BASE}/interactions`, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({
            model,
            input: prompt,
            response_format: { type: "video", aspect_ratio: aspectRatio, resolution: "720p" },
          }),
        }),
      );
      // The answer is usually complete; if not, wait for it.
      while (!findVideo(interaction) && !["failed", "cancelled", "error"].includes(interaction?.status)) {
        if (interaction?.status === "completed" || !interaction?.id) break;
        if (now() - started > TOTAL_TIMEOUT_MS) throw failed();
        await sleep(POLL_INTERVAL_MS);
        interaction = await readJson(
          await fetchImpl(`${API_BASE}/interactions/${encodeURIComponent(interaction.id)}`, { headers: headers() }),
        );
      }
      const part = findVideo(interaction);
      if (!part) {
        const text = JSON.stringify(interaction?.error || interaction?.steps || "");
        throw /safety|policy|block|prohibit|harm/iu.test(text)
          ? refused()
          : failed(`no video, status ${String(interaction?.status || "none").replace(/[^a-z_]/giu, "").slice(0, 30)}`);
      }
      const video = await download(part);
      return { video, mimeType: "video/mp4", prompt, model, aspectRatio };
    } catch (error) {
      if (!(error instanceof VideoGenerationError)) logSafeError("[Video generation]", error);
      await giveBack().catch(() => false);
      throw error instanceof VideoGenerationError
        ? error
        : failed(String(error?.name || "Error").replace(/[^A-Za-z]/gu, "").slice(0, 40));
    }
  }
  return { generate };
}

let defaultService;
export function getVideoGenerationService() {
  return (defaultService ||= createVideoGenerationService());
}
