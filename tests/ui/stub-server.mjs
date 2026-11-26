// A tiny stand-in for the AI CORE server, so the browser robot can click
// through the real page (public/) without sign-in, secrets or AI cost.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
const ASSISTANTS = [
  { id: "lawyer", label: "Юрист", icon: "fa-scale-balanced", hint: "Закони и договори" },
  { id: "teacher", label: "Учител", icon: "fa-chalkboard-user", hint: "Обяснява просто" },
];
const TYPES = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png", ".json": "application/json", ".webmanifest": "application/manifest+json" };

export function startStubServer(port = 0) {
  const requests = [];
  const feedback = [];
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
    if (p === "/chat/models") return json(res, { items: MODELS });
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
        const words = `Отговор от ${b.model}${b.assistant ? ` [${b.assistant}]` : ""} на „${b.message}“ думи думи думи думи думи думи`.split(" ");
        let i = 0;
        const timer = setInterval(() => {
          if (i >= words.length) {
            clearInterval(timer);
            send("done", { ok: true, provider: "claude", model: b.model });
            return res.end();
          }
          send("token", { token: (i ? " " : "") + words[i++] });
        }, b.message.includes("бавно") ? 300 : 10);
        res.on("close", () => clearInterval(timer));
      });
      return undefined;
    }
    if (p === "/api/ai-spend") return json(res, { month: "2026-11", totalUsd: 1, limitUsd: 10, percent: 10, models: [] });
    if (p.startsWith("/api/") || p.startsWith("/memory") || p.startsWith("/health")) {
      return json(res, { items: [], status: "ok", state: {} });
    }
    const hashed = p.match(/^\/assets\/[^/]+\/(.+)$/u);
    if (hashed) p = `/${hashed[1]}`;
    if (p.startsWith("/s/")) p = "/shared.html";
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
