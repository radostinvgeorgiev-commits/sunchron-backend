import { reservePublicAiVideo } from "./publicAiBudget.js";
import { logSafeError } from "../utils/safeLogging.js";
import { createGoogleAuthClient } from "./googleAdcAuth.js";
import { resolveVertexAiProjectId } from "./vertexAiGeminiService.js";
import { getVideoSoundService } from "./videoSoundService.js";

// "Направи видео": a short clip (ads and other) from a text description.
// Gemini Omni Flash through the Gemini API key that Novarium already uses.
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
const failed = (reason = "", provider = "Gemini", upstreamStatus = 0) =>
  Object.assign(
    new VideoGenerationError(`Видеото не стана${reason ? ` (${provider}: ${reason})` : ""}. Опитай пак. Единиците са върнати.`),
    { upstreamStatus },
  );
// Vertex AI Veo through the Cloud Run service identity (the same billing as
// the other Vertex models). Used when the Gemini API key has no video quota
// (429 on 2026-11-27) or the model is not open for it.
export const DEFAULT_VERTEX_VIDEO_MODELS = Object.freeze(["veo-3.1-fast-generate-001", "veo-3.1-lite-generate-001"]);
const VERTEX_VIDEO_LOCATION = "us-central1";
const FALL_BACK_STATUSES = new Set([401, 403, 404, 429, 503]);
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
  // Voice and music on top of the clip; null leaves the clip as it is.
  addSound = null,
  vertexAuthorization = async (url) => {
    const client = await createGoogleAuthClient();
    const headers = await client.getRequestHeaders(url);
    const value = typeof headers?.get === "function" ? headers.get("authorization") : headers?.Authorization || headers?.authorization;
    if (!value) throw new VideoGenerationError("Vertex AI няма достъп.", 503, "VIDEO_NOT_CONFIGURED");
    return value;
  },
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
    throw failed(reason, "Gemini", response.status);
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

  async function generateWithGemini(prompt, aspectRatio) {
    const model = env.GEMINI_OMNI_VIDEO_MODEL || DEFAULT_VIDEO_MODEL;
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
      if (now() - started > TOTAL_TIMEOUT_MS) throw failed("timeout");
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
    return { video: await download(part), model };
  }

  async function vertexJson(url, body) {
    const authorization = await vertexAuthorization(url);
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authorization },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (response.ok) return data;
    const upstream = String(data?.error?.status || "").match(/^[A-Z][A-Z0-9_]{1,63}$/u)?.[0] || "";
    logSafeError(
      "[Video generation] Vertex refused",
      Object.assign(new Error("Vertex video request failed"), { status: response.status, upstreamErrorStatus: upstream || undefined }),
    );
    if (response.status === 400 && /safety|policy|block|prohibit|harm|responsible/iu.test(JSON.stringify(data?.error || ""))) throw refused();
    throw failed(`${response.status}${upstream ? ` ${upstream}` : ""}`, "Vertex", response.status);
  }

  async function generateWithVertex(prompt, aspectRatio, projectId) {
    const models = String(env.VERTEX_VIDEO_MODELS || "").split(",").map((item) => item.trim()).filter((item) => /^[a-z][a-z0-9.-]{0,127}$/u.test(item));
    let lastError;
    for (const model of models.length ? models : DEFAULT_VERTEX_VIDEO_MODELS) {
      const base = `https://${VERTEX_VIDEO_LOCATION}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${VERTEX_VIDEO_LOCATION}/publishers/google/models/${model}`;
      let operation;
      try {
        operation = await vertexJson(`${base}:predictLongRunning`, {
          instances: [{ prompt }],
          parameters: { aspectRatio, durationSeconds: 8, resolution: "720p", generateAudio: true, sampleCount: 1 },
        });
      } catch (error) {
        // A model that is not open for the project: try the next one.
        if (error?.upstreamStatus === 404) {
          lastError = error;
          continue;
        }
        throw error;
      }
      if (!operation?.name) throw failed("no operation", "Vertex");
      const started = now();
      let result = operation;
      while (!result?.done) {
        if (now() - started > TOTAL_TIMEOUT_MS) throw failed("timeout", "Vertex");
        await sleep(POLL_INTERVAL_MS);
        result = await vertexJson(`${base}:fetchPredictOperation`, { operationName: operation.name });
      }
      if (result.error) {
        const text = JSON.stringify(result.error);
        throw /safety|policy|block|prohibit|harm|responsible/iu.test(text) ? refused() : failed(`code ${Number(result.error.code) || 0}`, "Vertex");
      }
      const clip = result.response?.videos?.[0];
      if (!clip?.bytesBase64Encoded) {
        throw Number(result.response?.raiMediaFilteredCount) > 0 ? refused() : failed("no video", "Vertex");
      }
      const video = Buffer.from(clip.bytesBase64Encoded, "base64");
      if (!video.length || video.length > MAX_VIDEO_BYTES) throw failed("empty video", "Vertex");
      return { video, model };
    }
    throw lastError || failed("no model", "Vertex");
  }

  async function generate(value, options = {}) {
    const prompt = cleanVideoPrompt(value);
    const vertexProject = resolveVertexAiProjectId(env);
    if (!env.GEMINI_API_KEY && !vertexProject) {
      throw new VideoGenerationError("Видеата не са настроени.", 503, "VIDEO_NOT_CONFIGURED");
    }
    const aspectRatio = pickAspectRatio(prompt, options.aspectRatio);
    const giveBack = await reserve(env.GEMINI_API_KEY ? "gemini" : "vertex", env.GEMINI_OMNI_VIDEO_MODEL || DEFAULT_VIDEO_MODEL);
    try {
      let made;
      if (env.GEMINI_API_KEY) {
        try {
          made = await generateWithGemini(prompt, aspectRatio);
        } catch (error) {
          // No video quota or access on the key: Vertex AI, when it is set up.
          if (!vertexProject || !FALL_BACK_STATUSES.has(error?.upstreamStatus)) throw error;
        }
      }
      made ||= await generateWithVertex(prompt, aspectRatio, vertexProject);
      const sound = addSound
        ? await addSound(made.video, prompt, options).catch(() => null)
        : null;
      return {
        video: sound?.video || made.video,
        mimeType: "video/mp4",
        prompt,
        model: made.model,
        aspectRatio,
        narration: sound?.narration || "",
        music: Boolean(sound?.music),
      };
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
  return (defaultService ||= createVideoGenerationService({
    addSound: (video, prompt, options) => getVideoSoundService().addSound(video, prompt, options),
  }));
}
