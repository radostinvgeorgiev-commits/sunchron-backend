import { DEFAULT_GEMINI_API_URL, DEFAULT_GEMINI_CHAT_MODEL } from "./novariumService.js";
import { reservePublicAiFile } from "./publicAiBudget.js";
import { searchWeb } from "./webSearchService.js";

// Two tools that ride on the Gemini key NovariumAI already has, so nothing new
// is switched on in Google Cloud: a YouTube video read by Gemini from its link,
// and places/routes answered with Google Maps grounding.

const YOUTUBE_URL_PATTERN =
  /https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?[^\s]*v=|shorts\/|live\/)|youtu\.be\/)[\w-]{6,}[^\s]*/iu;

// Google retired 2.5 Flash for new keys and points to 3.8 Flash; override with
// GEMINI_MAPS_MODEL when Google moves it.
export const DEFAULT_MAPS_MODEL = "gemini-3.8-flash";

export class GeminiToolError extends Error {
  constructor(message, status = 502, code = "GEMINI_TOOL_ERROR") {
    super(message);
    this.name = "GeminiToolError";
    this.status = status;
    this.code = code;
  }
}

export function extractYoutubeUrl(message) {
  if (typeof message !== "string") return "";
  const match = message.match(YOUTUBE_URL_PATTERN);
  return match ? match[0].replace(/[)\].,!?"'»“]+$/u, "") : "";
}

export function isYoutubeRequest(message) {
  return Boolean(extractYoutubeUrl(message));
}

// A kind of place in any noun form ("аптеката", "хотелът"), but not as an
// adjective ("ресторантска паста", "хотелска стая").
const PLACE_WORD =
  /(?:ресторант|кафене|аптек|болниц|хотел|бензиностанци|магазин|паркинг|фитнес|зъболекар)(?!ск)[а-яё]*/iu;
const SPATIAL_CUE =
  /(?:[Нн]аблизо|[Бб]лизо\s+до|в\s+района|около\s+мен|[Кк]ъде|(?:^|\s)в(?:ъв)?\s+[А-ЯЁ][а-яё]+)/u;
const ASKS =
  /(?:намери|покажи|препоръчай|предложи|търся|къде|има\s+ли|кой|коя|кое|кои|\?)/iu;
const DECLINES = /(?:^|\s)не\s+(?:искам|търся|ми\s+трябва|ми\s+трябват)/iu;

export function isPlacesRequest(message) {
  if (typeof message !== "string") return false;
  const text = message.trim();
  if (!text || isYoutubeRequest(text) || DECLINES.test(text)) return false;
  return (
    (PLACE_WORD.test(text) && SPATIAL_CUE.test(text) && ASKS.test(text)) ||
    /(?:маршрут|как\s+да\s+стигна|колко\s+(?:е\s+)?далеч|работно\s+време\s+на|на\s+картата|в\s+google\s+maps)/iu.test(text) ||
    /^(?:намери\s+наблизо|find\s+nearby)\s*:/iu.test(text) ||
    /\b(?:near\s+me|directions\s+to|route\s+to|opening\s+hours\s+of)\b/iu.test(text)
  );
}

function geminiConfig(env) {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new GeminiToolError("Gemini не е конфигуриран.", 503, "GEMINI_NOT_CONFIGURED");
  }
  return {
    apiKey,
    baseUrl: String(env.GEMINI_API_URL || DEFAULT_GEMINI_API_URL).replace(/\/+$/u, ""),
  };
}

async function callGemini(body, { env, model, fetchImpl, signal, label }) {
  const { apiKey, baseUrl } = geminiConfig(env);
  let response;
  try {
    response = await fetchImpl(`${baseUrl}/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
      signal,
    });
  } catch {
    throw new GeminiToolError(`${label} беше прекъснато. Опитай пак.`, 502, "GEMINI_TOOL_INTERRUPTED");
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.error(
      `[Gemini tool] ${label} upstream failed: ${response.status} ${detail.replace(/\s+/gu, " ").slice(0, 300)}`,
    );
    throw new GeminiToolError(`${label} временно не е достъпно.`, 502, "GEMINI_TOOL_UPSTREAM_ERROR");
  }
  const data = await response.json();
  const candidate = data?.candidates?.[0];
  const text = (candidate?.content?.parts || [])
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .join("")
    .trim();
  if (!text) {
    throw new GeminiToolError(`${label} не върна отговор.`, 502, "GEMINI_TOOL_EMPTY");
  }
  return { text, candidate };
}

export async function summarizeYoutubeVideo(
  message,
  {
    env = process.env,
    fetchImpl = fetch,
    model = env.GEMINI_VIDEO_MODEL || env.GEMINI_MODEL || DEFAULT_GEMINI_CHAT_MODEL,
    signal = AbortSignal.timeout(120000),
  } = {},
) {
  const url = extractYoutubeUrl(message);
  if (!url) throw new GeminiToolError("Сложи линк към видео в YouTube.", 400, "YOUTUBE_URL_MISSING");
  const question = String(message).replace(url, "").trim();
  await reservePublicAiFile("gemini", model);
  const { text } = await callGemini(
    {
      contents: [
        {
          role: "user",
          parts: [
            { fileData: { fileUri: url } },
            {
              text: [
                "Отговори на български език.",
                question && !/^обобщи(?:\s+(?:ми|това))?(?:\s+видео(?:то)?)?\s*:?$/iu.test(question)
                  ? `Въпросът за видеото: ${question}`
                  : "Обобщи видеото: за какво е, основните точки и какво може да се приложи на практика.",
                "Не измисляй неща, които ги няма във видеото.",
              ].join("\n"),
            },
          ],
        },
      ],
    },
    { env, model, fetchImpl, signal, label: "Четенето на видеото" },
  );
  return { text, sources: [{ title: "Видеото в YouTube", url }] };
}

export function extractMapsSources(candidate) {
  const sources = [];
  const seen = new Set();
  for (const chunk of candidate?.groundingMetadata?.groundingChunks || []) {
    const place = chunk?.maps || chunk?.web;
    if (!place?.uri || seen.has(place.uri)) continue;
    seen.add(place.uri);
    sources.push({ title: place.title || place.uri, url: place.uri });
  }
  return sources.slice(0, 8);
}

export async function askGoogleMaps(
  message,
  {
    env = process.env,
    fetchImpl = fetch,
    model = env.GEMINI_MAPS_MODEL || DEFAULT_MAPS_MODEL,
    signal = AbortSignal.timeout(60000),
    fallbackSearch = searchWeb,
  } = {},
) {
  const question = typeof message === "string" ? message.trim().slice(0, 1500) : "";
  if (!question) throw new GeminiToolError("Напиши какво място търсиш.", 400, "PLACES_QUERY_EMPTY");
  await reservePublicAiFile("gemini", model);
  let reply;
  try {
    reply = await callGemini(
    {
      contents: [
        {
          role: "user",
          parts: [
            {
              text: [
                "Отговори на български език, кратко и практично.",
                "Използвай Google Maps за места, адреси, работно време, оценки и маршрути.",
                "Ако не е посочен град или район, дай най-доброто, което можеш, и накрая кажи, че с име на града ще е по-точно (например „Намери наблизо: аптека в Пловдив“).",
                "",
                question,
              ].join("\n"),
            },
          ],
        },
      ],
      tools: [{ googleMaps: {} }],
    },
    { env, model, fetchImpl, signal, label: "Търсенето в картите" },
  );
  } catch (error) {
    // Maps grounding can be out of quota or not offered for the key; the
    // person still gets an answer about the place from a web search.
    if (!(error instanceof GeminiToolError) || error.status === 400 || error.code === "GEMINI_NOT_CONFIGURED" || !fallbackSearch) throw error;
    return fallbackSearch(`${question}\nДай адрес, работно време и как да се стигне, ако е подходящо.`);
  }
  return { text: reply.text, sources: extractMapsSources(reply.candidate) };
}

export function formatGeminiToolResult(result) {
  const lines = (result.sources || []).map(({ title, url }) => `• [${title}](${url})`);
  return [result.text, lines.length ? "Източници:" : "", ...lines].filter(Boolean).join("\n");
}
