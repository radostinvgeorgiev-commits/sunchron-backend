// A tiny stand-in for the AI CORE server, so the browser robot can click
// through the real page (public/) without sign-in, secrets or AI cost.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listAssistantPresets } from "../../src/services/assistantPresets.js";

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

export function startStubServer(port = 0) {
  const requests = [];
  const todos = [];
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
  let workspace = null;
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
    if (p === "/__robot/google-connected" || p === "/__robot/google-disconnected") {
      googleConnected = p.endsWith("/google-connected");
      return json(res, { ok: true });
    }
    if (p === "/api/images" && req.method === "POST") {
      return json(res, { image: "data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==", prompt: "котка" });
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
      ] });
    }
    if (p === "/api/google/files") return json(res, { files: [] });
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
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        if (b.council) {
          send("token", { token: "## AI CORE Council\n\n### Claude · m1\nОтговор А.\n\n### Gemini · m2\nОтговор Б.\n\n### ✅ Съгласни\n- Да\n\n## Обща препоръка (high)\nДобре." });
          send("done", { ok: true, mode: "council", council: { responses: [
            { provider: "claude", model: "m1", text: "Отговор А." },
            { provider: "gemini", model: "m2", text: "Отговор Б." },
          ] } });
          return res.end();
        }
        const words = (b.message.includes("списък")
          ? "Ето списък за пазар:\n- Мляко\n- Хляб\n- **Яйца**"
          : `Отговор от ${b.model}${b.assistant ? ` [${b.assistant}]` : ""} на „${b.message}“ думи думи думи думи думи думи`
        ).split(" ");
        let i = 0;
        const timer = setInterval(() => {
          if (i >= words.length) {
            clearInterval(timer);
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
    if (p.startsWith("/api/") || p.startsWith("/memory") || p.startsWith("/health")) {
      return json(res, { items: [], status: "ok", state: {} });
    }
    const hashed = p.match(/^\/assets\/[^/]+\/(.+)$/u);
    if (hashed) p = `/${hashed[1]}`;
    if (p.startsWith("/s/")) p = "/shared.html";
    if (p.startsWith("/a/")) p = "/avatar.html";
    if (p === "/status") p = "/status.html";
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
      resolve({ server, requests, feedback, origin: `http://127.0.0.1:${server.address().port}` }),
    );
  });
}
