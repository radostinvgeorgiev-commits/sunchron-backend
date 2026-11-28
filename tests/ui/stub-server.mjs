// A tiny stand-in for the NovariumAI server, so the browser robot can click
// through the real page (public/) without sign-in, secrets or AI cost.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listAssistantPresets } from "../../src/services/assistantPresets.js";
import { createAddonService } from "../../src/services/addonService.js";
import { createBookMemoryService } from "../../src/services/bookMemoryService.js";
// The server's own rules for pictures and video in the chat, so the robot can
// only pass on what the server does.
import {
  chatMediaEvent,
  mediaOffer,
  mediaYesAnswer,
  shortYesTurns,
} from "../../src/services/chatMediaProposals.js";
import { useEnglishReplyFallback } from "../../src/config/replyLanguage.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "public");
const json = (res, body, status = 200) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};
const MODELS = [
  { id: "auto", label: "Автоматичен", hint: "Claude Haiku 5.5", available: true },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 5.5", hint: "", available: true },
  { id: "gemini-2.5-flash-lite", label: "Gemini 3.5 Flash Lite", hint: "", available: true },
  { id: "grok-3-mini", label: "Grok 3 Mini", hint: "", available: false },
];
// The real list, so the robot sees what people see.
const ASSISTANTS = listAssistantPresets();
const TYPES = { ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png", ".json": "application/json", ".webmanifest": "application/manifest+json" };
// A 1×1 picture, as /api/images sends a made one.
const TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
// The pictures and the video an answer describes.
export const MEDIA_DESCRIPTIONS = Object.freeze([
  { kind: "image", prompt: "Чаша кафе на дървена маса, сутрешна светлина" },
  { kind: "image", prompt: "Баристка подава кафе през прозорче, усмихва се" },
  { kind: "video", prompt: "Пара над чаша кафе, после надпис „Добро утро“" },
]);
// The answer as the server's rule asks the model for it: a description per
// item on its own line, a blank line after each, and the offer last.
export const MEDIA_ANSWER = [
  "Ето рекламата: „Кафе, което събужда града.“",
  "",
  ...MEDIA_DESCRIPTIONS.flatMap((item, at) => [
    item.kind === "video" ? `Видео: ${item.prompt}` : `Картинка ${at + 1}: ${item.prompt}`,
    "",
  ]),
  "Следва: напиши „да“ и правя картинките и видеото.",
].join("\n");
// The same offer for the first picture alone, with a short sentence after
// the offer line: the card still comes, and a short yes still starts it.
export const MEDIA_TRAILING_ANSWER = [
  "Ето идеята за поста.",
  "",
  `Картинка 1: ${MEDIA_DESCRIPTIONS[0].prompt}`,
  "",
  "Следва: напиши „да“ и правя картинката.",
  "",
  "Ако искаш друг стил, кажи.",
].join("\n");
// A full card: four pictures and a video, ten lines of the page's own once
// made (review r2: an edit of the yes after them lost the offer above).
export const FULL_DESCRIPTIONS = Object.freeze([
  { kind: "image", prompt: "Витрина на кафене сутрин, топла светлина, квадратен формат" },
  { kind: "image", prompt: "Ръце държат чаша капучино със сърце от мляко, отгоре" },
  { kind: "image", prompt: "Маса до прозорец с книга и кроасан, меки цветове" },
  { kind: "image", prompt: "Баристка мели кафе, близък план, вертикално 4:5" },
  { kind: "video", prompt: "Камерата минава покрай витрината и спира на чаша кафе" },
]);
export const MEDIA_FULL_ANSWER = [
  "Ето кампанията за кафенето.",
  "",
  ...FULL_DESCRIPTIONS.flatMap((item, at) => [
    item.kind === "video" ? `Видео: ${item.prompt}` : `Картинка ${at + 1}: ${item.prompt}`,
    "",
  ]),
  "Следва: напиши „да“ и правя картинките и видеото.",
].join("\n");
// What the stub's account can make: both, as with the keys set.
const MEDIA_AVAILABLE = Object.freeze({ images: true, video: true });

export function startStubServer(port = 0) {
  const requests = [];
  // Every picture and clip the page asked for: { path, prompt, at }.
  const media = [];
  // Whether the robot plays a member (pays units) and how long a picture or
  // a clip takes, so „Спри“ can be pressed while one is being made.
  let member = false;
  let mediaDelay = 0;
  // The next chat request fails with HTTP 502, as a proxy's error would.
  let failNextChat = false;
  // The saved turns of each conversation, as the server keeps them: the page
  // restores them after a reload. The page's own picture lines are not saved.
  const conversations = new Map();
  const remember = (sent, reply) => {
    const turns = conversations.get(sent.sessionId) || [];
    turns.push({ role: "user", content: sent.message }, { role: "assistant", content: reply });
    conversations.set(sent.sessionId, turns);
  };
  const todos = [];
  // The real add-on service and sandbox, with memory instead of Firestore and
  // fixed weather instead of the internet.
  const addonRows = new Map();
  const addons = createAddonService({
    store: {
      async get(collection, id) {
        const data = addonRows.get(`${collection}/${id}`);
        return data ? { id, data: structuredClone(data) } : null;
      },
      async commitOperations(operations) {
        for (const { type, collection, id, data } of operations) {
          if (type === "delete") addonRows.delete(`${collection}/${id}`);
          else addonRows.set(`${collection}/${id}`, structuredClone(data));
        }
      },
    },
    fetchData: async () => ({ current_weather: { temperature: 7.5, windspeed: 3 } }),
  });
  // The real "Писател" service, with memory instead of Firestore and a fixed
  // model: it suggests one fact, and finds brown eyes against green ones.
  const bookRows = new Map();
  const books = createBookMemoryService({
    env: {},
    store: {
      async get(collection, id) {
        const data = bookRows.get(`${collection}/${id}`);
        return data ? { id, data: structuredClone(data) } : null;
      },
      async commitOperations(operations) {
        for (const { type, collection, id, data } of operations) {
          if (type === "delete") bookRows.delete(`${collection}/${id}`);
          else bookRows.set(`${collection}/${id}`, structuredClone(data));
        }
      },
    },
    askAi: async ({ input }) => {
      const asked = input[1].content;
      if (asked.includes("[ПЛАН ЗА ГЛАВА")) return "Сутринта Мила погледна с кафявите си очи към кулата.";
      if (!asked.includes("[ПАМЕТ]")) {
        return '{"facts":[{"kind":"place","name":"Кулата","text":"Кулата е на хълма.","quote":"кулата на хълма"}]}';
      }
      const eyes = asked.match(/^(\S+) \| character \| Мила/mu);
      const quote = asked.match(/Мила погледна с кафявите си очи/u);
      return JSON.stringify({ issues: eyes && quote ? [{ fact: eyes[1], quote: quote[0], why: "Очите ѝ са зелени." }] : [] });
    },
  });
  let avatarLink = { active: false, card: {} };
  const visitorQuestions = [];
  const feedback = [];
  let library = { assistants: [], prompts: [] };
  let files = [];
  const AVATAR_FIELDS = [
    { id: "about", label: "Кой съм", max: 1200 },
    { id: "style", label: "Как говоря и как да ми отговаряш", max: 800 },
  ];
  let avatarProfile = {};
  let causes = [];
  let googleConnected = false;
  let googleLight = false;
  let workspace = null;
  let claudeWorkFiles = [];
  // What the contact form on /help sent, so the robot can check it arrived.
  const contactMessages = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://stub");
    let p = url.pathname;
    if (p === "/api/auth/session") {
      return json(res, {
        configured: true, registrationEnabled: true, registrationMode: "public",
        authProvider: "identity-platform", googleSignIn: true, authenticated: true,
        user: { id: "u", email: "robot@example.test", displayName: "Робот", role: "owner" },
      });
    }
    if (p === "/health/status") {
      return json(res, { status: "partial", site: true, checkedAt: "2026-11-26T03:00:00Z", models: [
        { name: "Claude", working: true }, { name: "Gemini", working: false },
      ] });
    }
    if (p === "/api/knowledge-files" && req.method === "GET") return json(res, { files });
    if (p === "/api/knowledge-files" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const sent = JSON.parse(body);
        files.push({ id: `f${files.length}`, name: sent.name, chars: (sent.text || "").length });
        json(res, { file: files.at(-1) }, 201);
      });
      return undefined;
    }
    if (p.startsWith("/api/knowledge-files/") && req.method === "DELETE") {
      files = files.filter(({ id }) => id !== p.split("/").pop());
      return json(res, { removed: true });
    }
    if (p === "/__robot/google-connected" || p === "/__robot/google-disconnected" || p === "/__robot/google-light") {
      googleConnected = !p.endsWith("/google-disconnected");
      // "Свържи Google" without the whole Drive: listing files is not allowed.
      googleLight = p.endsWith("/google-light");
      return json(res, { ok: true });
    }
    if (p === "/__robot/member" || p === "/__robot/owner") {
      member = p.endsWith("/member");
      return json(res, { ok: true });
    }
    if (p === "/__robot/fail-chat") {
      failNextChat = true;
      return json(res, { ok: true });
    }
    if (p === "/__robot/slow-media" || p === "/__robot/fast-media") {
      mediaDelay = p.endsWith("/slow-media") ? 1500 : 0;
      return json(res, { ok: true });
    }
    if (p.startsWith("/memory/conversation/") && req.method === "GET") {
      const sessionId = decodeURIComponent(p.slice("/memory/conversation/".length));
      return json(res, { items: conversations.get(sessionId) || [] });
    }
    if ((p === "/api/images" || p === "/api/videos") && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const { prompt } = JSON.parse(body || "{}");
        media.push({ path: p, prompt, at: Date.now() });
        setTimeout(() => {
          if (p === "/api/images") return json(res, { image: TINY_PNG, prompt });
          // A few bytes in place of the MP4 file.
          res.writeHead(200, { "Content-Type": "video/mp4" });
          return res.end(Buffer.from("MP4 clip"));
        }, mediaDelay);
      });
      return undefined;
    }
    if (p === "/api/avatar-link") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        if (req.method === "PUT") avatarLink = { active: true, url: `http://${req.headers.host}/a/AbCdEfGhIjKlMnOpQrStUvWxYz012345`, card: JSON.parse(body).card, usedToday: 0, perDay: 30 };
        if (req.method === "DELETE") avatarLink = { active: false, card: avatarLink.card };
        return json(res, avatarLink);
      });
      return undefined;
    }
    if (p.startsWith("/api/avatar-visit/")) {
      if (!avatarLink.active) return json(res, { error: "Този аватар не е достъпен или линкът е спрян." }, 404);
      if (p.endsWith("/ask")) {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          visitorQuestions.push(JSON.parse(body));
          json(res, { answer: `Работното време на ${avatarLink.card.name} е от 9 до 17 ч.` });
        });
        return undefined;
      }
      return json(res, { name: avatarLink.card.name, intro: avatarLink.card.intro });
    }
    // "Работа с Claude": a fixed answer with one file, so the page can be checked.
    if (p === "/api/claude-work") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        const skills = [{ id: "pptx", label: "Презентация (PowerPoint)" }, { id: "pdf", label: "PDF" }];
        if (req.method === "GET") return json(res, { skills, addons: await addons.claudeChoices("robot"), files: claudeWorkFiles });
        const data = JSON.parse(body || "{}");
        const picked = await addons.forClaude("robot", data.addons);
        if (picked.skills.length) {
          return json(res, { text: `Умения: ${picked.skills.map((skill) => skill.name).join(", ")}`, files: [], model: "claude-haiku-5-5" });
        }
        const file = { id: "file_robot", name: "reklama.pptx", mimeType: "application/octet-stream", size: 5 };
        claudeWorkFiles = [file];
        return json(res, { text: `Готово: ${data.task} (${(data.skills || []).join(",")})`, files: [file], model: "claude-haiku-5-5" });
      });
      return undefined;
    }
    if (p === "/api/claude-work/files/file_robot") {
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": 'attachment; filename="reklama.pptx"' });
      return res.end("PPTX!");
    }
    if (p.startsWith("/api/addons/")) {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        const data = JSON.parse(body || "{}");
        const [, , , area, rawId, action] = p.split("/");
        const id = decodeURIComponent(rawId || "");
        const me = "robot";
        try {
          if (area === "store" && !id) return json(res, { items: await addons.listPublic() });
          if (area === "store" && action === "run") return json(res, await addons.runPublic(id, data.input));
          if (area === "review" && !id) return json(res, { items: await addons.listPending() });
          if (area === "review" && action === "run") return json(res, await addons.runPending(id, data.input));
          if (area === "review" && action === "approve") return json(res, await addons.approve(id, data.note));
          if (area === "review" && action === "reject") return json(res, await addons.reject(id, data.note));
          if (area === "test") return json(res, await addons.test(me, data));
          if (area === "mine" && !id && req.method === "GET") return json(res, { items: await addons.listMine(me) });
          if (area === "mine" && !id && req.method === "POST") return json(res, await addons.save(me, data));
          if (area === "mine" && req.method === "DELETE") return json(res, { items: await addons.remove(me, id) });
          if (area === "mine" && action === "submit") return json(res, { items: await addons.submit(me, id) });
          if (area === "mine" && action === "unpublish") return json(res, { items: await addons.unpublish(me, id) });
          if (area === "mine" && action === "run") return json(res, await addons.runMine(me, id, data.input));
          return json(res, { error: "няма" }, 404);
        } catch (error) {
          return json(res, { error: error.message }, error.status || 500);
        }
      });
      return undefined;
    }
    if (p.startsWith("/api/books")) {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        const data = JSON.parse(body || "{}");
        const [, , , bookId, area, factId, action] = p.split("/").map((part) => decodeURIComponent(part));
        const me = "robot";
        try {
          if (!bookId && req.method === "GET") return json(res, { books: await books.list(me) });
          if (!bookId && req.method === "POST") return json(res, { book: await books.createBook(me, data.title) }, 201);
          if (!area && req.method === "DELETE") return json(res, { books: await books.removeBook(me, bookId) });
          if (area === "facts" && action === "change") return json(res, { book: await books.changeFact(me, bookId, factId, data) });
          if (area === "facts" && req.method === "POST") return json(res, { book: await books.addFacts(me, bookId, data.facts) });
          if (area === "facts" && req.method === "DELETE") return json(res, { book: await books.removeFact(me, bookId, factId) });
          if (area === "suggest") return json(res, { suggestions: await books.suggestFacts(me, bookId, data) });
          if (area === "check") return json(res, { result: await books.checkChapter(me, bookId, data) });
          if (area === "chapters" && req.method === "POST") return json(res, { book: await books.saveChapters(me, bookId, data.chapters) });
          if (area === "chapters" && req.method === "GET") return json(res, { chapter: await books.getChapter(me, bookId, factId) });
          if (area === "chapters" && req.method === "DELETE") return json(res, { book: await books.removeChapter(me, bookId, factId) });
          if (area === "draft") return json(res, { draft: await books.draftChapter(me, bookId, data) });
          if (area === "export") {
            const file = await books.exportBook(me, bookId, url.searchParams.get("format") || "");
            res.writeHead(200, { "Content-Type": file.type });
            return res.end(file.body);
          }
          return json(res, { error: "няма" }, 404);
        } catch (error) {
          return json(res, { error: error.message }, error.status || 500);
        }
      });
      return undefined;
    }
    if (p.startsWith("/api/todos")) {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const data = JSON.parse(body || "{}");
        const id = decodeURIComponent(p.split("/")[3] || "");
        if (id === "from-note") return json(res, { suggestions: ["Обади се на счетоводителя", "Плати тока до петък"] });
        if (req.method === "POST") todos.unshift(...data.items.map((text, at) => ({ id: `t${Date.now()}${at}`, text, done: false })));
        if (req.method === "PATCH") todos.forEach((item) => item.id === id && (item.done = data.done));
        if (req.method === "DELETE") todos.splice(todos.findIndex((item) => item.id === id), 1);
        return json(res, { items: todos });
      });
      return undefined;
    }
    if (p === "/api/daily-plan" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const week = JSON.parse(body || "{}").period === "week";
        json(res, {
          text: week ? "**Трите най-важни за седмицата:** пусни гласа." : "**Най-важното днес:** провери сайта.",
          sources: { profile: false, calendar: null, mail: null },
        });
      });
      return undefined;
    }
    if (p === "/api/google/status") return json(res, { connected: googleConnected, canRestore: false });
    // Gmail answers, Contacts refuses: the tools list must show both truthfully.
    if (p === "/api/google/check") {
      return json(res, googleConnected
        ? { connected: true, services: { drive: { ok: true }, gmail: { ok: true }, calendar: { ok: true }, contacts: { ok: false, reason: "Google отказа достъп до контактите." }, youtube: { ok: false, connect: "/api/google/connect?add=youtube", reason: "Още не е разрешен." } } }
        : { connected: false, services: {} });
    }
    // Web search answers, photos (Claude) does not: both shown truthfully.
    if (p === "/api/tools/check") {
      return json(res, { checkedAt: new Date().toISOString(), tools: {
        "openai-web-search": { ok: true },
        images: { ok: false, reason: "Claude: претоварен." },
      } });
    }
    if (p === "/health/integrations") {
      return json(res, { tools: [
        { id: "gmail-read", name: "Gmail", enabled: true, executable: true, configured: true },
        { id: "google-contacts", name: "Google Contacts", enabled: true, executable: true, configured: true },
        { id: "youtube-channel", name: "Моят YouTube канал", enabled: true, executable: true, configured: true },
        { id: "openai-web-search", name: "Търсене в интернет", enabled: true, executable: true, configured: true },
      ] });
    }
    if (p === "/api/google/save" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const b = JSON.parse(body);
        if (!b.text || !b.title) return json(res, { error: "Няма какво да се запази." }, 400);
        json(res, { id: "f1", name: b.title, kind: b.kind, url: `https://docs.google.com/${b.kind === "sheet" ? "spreadsheets" : "document"}/d/f1` });
      });
      return undefined;
    }
    if (p === "/api/activity") {
      return json(res, { days: [
        { date: "2026-11-26", active: 4, messages: 30, registrations: 2, landing_variant_1: 5, landing_variant_2: 1, landing_variant_3: 0 },
        { date: "2026-11-25", active: 2, messages: 11, registrations: 0, landing_variant_1: 0, landing_variant_2: 0, landing_variant_3: 3 },
      ], accounts: { total: 7, signedInLast7Days: 5 } });
    }
    if (p === "/api/google/files") {
      return googleLight
        ? json(res, { error: "Google Drive още не е разрешен.", code: "GOOGLE_SCOPE_REQUIRED" }, 403)
        : json(res, { files: [] });
    }
    if (p === "/api/google/gmail/messages") {
      return json(res, { messages: [{ id: "m1", subject: "Офертата", from: "Иван <ivan@example.com>", snippet: "Потвърди до петък", url: "https://mail.google.com/x" }] });
    }
    if (p === "/api/google/gmail/reply-draft" && req.method === "POST") {
      return json(res, { body: "Здравей, Иване!", draft: { url: "https://mail.google.com/mail/u/0/#drafts/x", to: "ivan@example.com", subject: "Re: Офертата" } });
    }
    if (p.startsWith("/api/causes")) {
      const id = p.split("/")[3];
      const send = () => json(res, { causes, moderator: true });
      if (req.method === "GET") return send();
      if (req.method === "DELETE") {
        causes = causes.filter((cause) => cause.id !== id);
        return send();
      }
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const sent = JSON.parse(body || "{}");
        if (p.endsWith("/prepare")) {
          causes.find((item) => item.id === id).project = "1. Цел: нова площадка.";
        } else if (id) {
          const cause = causes.find((item) => item.id === id);
          cause.liked = sent.on !== false;
          cause.likes += cause.liked ? 1 : -1;
        } else {
          causes.push({ id: `c${causes.length}`, title: sent.title, description: sent.description, author: "Робот", likes: 1, liked: true, mine: true });
        }
        send();
      });
      return undefined;
    }
    if (p === "/api/avatar-profile" && req.method === "GET") {
      return json(res, { profile: avatarProfile, fields: AVATAR_FIELDS });
    }
    if (p === "/api/avatar-profile" && req.method === "PUT") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        avatarProfile = JSON.parse(body).profile || {};
        json(res, { profile: avatarProfile, fields: AVATAR_FIELDS });
      });
      return undefined;
    }
    if (p === "/api/library" && req.method === "GET") return json(res, library);
    if (p === "/api/library" && req.method === "PUT") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const sent = JSON.parse(body);
        const withIds = (items) => (items || []).map((item, i) => ({ ...item, id: item.id || `aaaaaaaa-000${i}` }));
        library = { assistants: withIds(sent.assistants), prompts: withIds(sent.prompts) };
        json(res, library);
      });
      return undefined;
    }
    if (p === "/chat/meeting" && req.method === "POST") {
      let size = 0;
      req.on("data", (chunk) => (size += chunk.length));
      req.on("end", () => {
        requests.push({ meeting: true, type: req.headers["content-type"], name: decodeURIComponent(req.headers["x-file-name"] || ""), size });
        json(res, {
          text: "## Среща за бюджета\n\nОбсъдихме бюджета за декември.\n\n**Решения:**\n- Бюджетът остава същият\n\n**Задачи:**\n- Иван: оферта до петък\n- Мария: таблица с разходите",
          title: "Среща за бюджета",
          tasks: ["Иван: оферта до петък", "Мария: таблица с разходите"],
          savedToFiles: true,
        });
      });
      return;
    }
    if (p === "/chat/search" && req.method === "POST") {
      return json(res, { text: "Намерен отговор.", sources: [{ title: "Източник едно", url: "https://example.com/a" }] });
    }
    if (p === "/chat/models") return json(res, { items: MODELS });
    if (p === "/chat/work-models") {
      return json(res, { items: [
        { id: "auto", label: "Автоматичен", hint: "Препоръчано", available: true },
        { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", hint: "Най-високо качество", available: true },
        { id: "grok-4.5", label: "Grok 4.5", hint: "xAI", available: false },
      ] });
    }
    if (p === "/chat/compare" && req.method === "POST") {
      return json(res, { answers: [
        { text: "Отговор едно.", provider: "claude", model: "m1", label: "Claude Haiku 5.5" },
        { text: "Отговор две.", provider: "gemini", model: "m2", label: "Gemini 3.5 Flash Lite" },
      ] });
    }
    if (p === "/api/feedback" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        feedback.push(JSON.parse(body));
        json(res, { saved: true }, 201);
      });
      return undefined;
    }
    if (p === "/chat/assistants") return json(res, { items: ASSISTANTS });
    if (p.startsWith("/api/share/") && req.method === "GET") return json(res, { shared: false });
    if (p === "/api/share" && req.method === "POST") {
      return json(res, { shared: true, url: "https://cloudaicore.com/s/AbCdEfGhIjKlMnOpQrStUvWxYz012345" });
    }
    if (p.startsWith("/api/shared/")) {
      return json(res, { title: "Тест", createdAt: "2026-11-26T00:00:00Z", messages: [
        { role: "user", content: "Въпрос" }, { role: "assistant", content: "**Отговор**" },
      ] });
    }
    if (p === "/chat/chat" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const b = JSON.parse(body);
        requests.push(b);
        if (failNextChat) {
          failNextChat = false;
          b.failed = true;
          res.writeHead(502, { "Content-Type": "text/html" });
          return res.end("<h1>502 Bad Gateway</h1>");
        }
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const send = (event, data) => {
          // When the answer ended, so the robot can tell that pictures and
          // clips start only after it.
          if (event === "done") b.doneAt = Date.now();
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };
        if (b.council) {
          send("token", { token: "## NovariumAI Council\n\n### Claude · m1\nОтговор А.\n\n### Gemini · m2\nОтговор Б.\n\n### ✅ Съгласни\n- Да\n\n## Обща препоръка (high)\nДобре." });
          send("done", { ok: true, mode: "council", council: { responses: [
            { provider: "claude", model: "m1", text: "Отговор А." },
            { provider: "gemini", model: "m2", text: "Отговор Б." },
          ] } });
          return res.end();
        }
        // A prepared write waits for the exact command; the command runs it.
        if (b.message.startsWith("Създай събитие в календара")) {
          send("token", { token: [
            "Подготвих, но още нищо не е направено:",
            "- Създаване на събитие „Демо“ в Google Calendar: 2026-11-28 10:00 (Europe/Sofia), 30 мин.",
            "Потвърждение: 11111111-2222-3333-4444-555555555555. Валидно до: 2026-11-28T10:00:00.000Z.",
            "За изпълнение натисни „Потвърди“ или изпрати точно: Потвърждавам NovariumAI задача: 11111111-2222-3333-4444-555555555555",
          ].join("\n\n") });
          send("done", { ok: true, mode: "verified-tool-output", task: { id: "t1", status: "waiting_confirmation", verified: false, totalSteps: 1 } });
          return res.end();
        }
        if (b.message === "Потвърждавам NovariumAI задача: 11111111-2222-3333-4444-555555555555") {
          send("token", { token: "Потвърдената NovariumAI задача е изпълнена: 1 операции.\n\n- Календарното събитие е създадено: Демо." });
          send("done", { ok: true, mode: "task-confirmed-write", taskId: "t1" });
          return res.end();
        }
        // An answer that describes pictures and a video: the server's card
        // for it (a button each, the price for a member); nothing is made
        // before a press or a short yes.
        const mediaAnswer = b.message.includes("с картинки и видео")
          ? MEDIA_ANSWER
          : b.message.includes("с картинка и бележка")
            ? MEDIA_TRAILING_ANSWER
            : b.message.includes("с пълна карта")
              ? MEDIA_FULL_ANSWER
              : "";
        if (mediaAnswer) {
          const offer = mediaOffer(mediaAnswer, MEDIA_AVAILABLE);
          const event = offer.card ? chatMediaEvent(offer.items, { member }) : null;
          send("token", { token: mediaAnswer });
          send("done", { ok: true, provider: "claude", model: b.model, ...(event ? { media: event } : {}) });
          remember(b, mediaAnswer);
          return res.end();
        }
        // A short yes to the previous answer's offer: the server's own reply,
        // without the model. With the card the page shows it starts what the
        // card has not made; without it the card comes under the reply.
        if (!b.image) {
          const turns = shortYesTurns(conversations.get(b.sessionId), b.recentHistory, { rewrite: b.rewrite === true });
          const reply = mediaYesAnswer(b.message, turns, {
            mediaCard: b.mediaCard,
            available: MEDIA_AVAILABLE,
            member,
            english: useEnglishReplyFallback(b.language),
          });
          if (reply) {
            send("token", { token: reply.text });
            send("done", { ok: true, mode: "media-yes", ...(reply.media ? { media: reply.media } : {}) });
            remember(b, reply.text);
            return res.end();
          }
        }
        const words = (b.message.includes("списък")
          ? "Ето списък за пазар:\n- Мляко\n- Хляб\n- **Яйца**"
          : b.message.includes("команда")
          ? "Инсталирай зависимостите с `npm`:\n\n```bash\nnpm install\n```"
          : `Отговор от ${b.model}${b.assistant ? ` [${b.assistant}]` : ""} на „${b.message}“ думи думи думи думи думи думи`
        ).split(" ");
        let i = 0;
        const timer = setInterval(() => {
          if (i >= words.length) {
            clearInterval(timer);
            remember(b, words.join(" "));
            send("done", {
              ok: true,
              provider: "claude",
              model: b.model,
              ...(b.message.includes("Откъде")
                ? { sources: [{ kind: "file", label: "Бележки.pdf" }, { kind: "memory", label: "Рожденият ми ден е на 3 март" }] }
                : {}),
            });
            return res.end();
          }
          send("token", { token: (i ? " " : "") + words[i++] });
        }, b.message.includes("бавно") ? 300 : 10);
        res.on("close", () => clearInterval(timer));
      });
      return undefined;
    }
    if (p === "/api/ai-spend") return json(res, { month: "2026-11", totalUsd: 1, limitUsd: 10, percent: 10, models: [] });
    // Work mode keeps its state on the server; echo it back like the real one.
    if (p === "/api/workspaces" && req.method === "PUT") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        workspace = JSON.parse(body || "{}").state || null;
        json(res, { persisted: true, state: workspace });
      });
      return undefined;
    }
    if (p === "/api/workspaces") return json(res, { persisted: Boolean(workspace), state: workspace });
    // The contact form posts a normal form and is sent back to /help, like the
    // real server. A message with "[unavailable]" acts as a storage failure.
    if (p === "/api/contact" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const form = Object.fromEntries(new URLSearchParams(body));
        contactMessages.push(form);
        const lang = url.searchParams.get("lang");
        const result = form.message?.includes("[unavailable]") ? "unavailable" : "received";
        const query = new URLSearchParams({
          contact: result,
          ...(result === "received" ? { ticket: "ABCD0001" } : {}),
          ...(lang ? { lang } : {}),
        });
        res.writeHead(303, { Location: `/help?${query}#contact` });
        res.end();
      });
      return undefined;
    }
    if (p.startsWith("/api/") || p.startsWith("/memory") || p.startsWith("/health")) {
      return json(res, { items: [], status: "ok", state: {} });
    }
    const hashed = p.match(/^\/assets\/[^/]+\/(.+)$/u);
    if (hashed) p = `/${hashed[1]}`;
    if (p.startsWith("/s/")) p = "/shared.html";
    if (p.startsWith("/a/")) p = "/avatar.html";
    if (p === "/status") p = "/status.html";
    if (p === "/help") p = "/help.html";
    if (p === "/") p = "/index.html";
    const file = path.join(root, path.normalize(p));
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { "Content-Type": `${TYPES[path.extname(file)] || "application/octet-stream"}; charset=utf-8` });
    return fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () =>
      resolve({ server, requests, media, feedback, contactMessages, origin: `http://127.0.0.1:${server.address().port}` }),
    );
  });
}
