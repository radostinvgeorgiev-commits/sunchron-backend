import { randomBytes } from "node:crypto";
import express from "express";
import { rateLimit } from "express-rate-limit";
import { createFirestoreDocumentStore } from "../services/firestoreDocumentStore.js";

// The contact form on /help: the only way people reach us (manifesto §5, no
// phone). Messages are kept for the owner for up to one year.
export const CONTACT_COLLECTION = "synchron-contact-v1";
export const CONTACT_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
const noticeVersion = "contact-v1";
const emailPattern = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/u;
export const CONTACT_TOPICS = Object.freeze({
  question: "Въпрос",
  problem: "Проблем",
  idea: "Идея",
  data: "Моите данни",
  other: "Друго",
});

const controlCharacters = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;
const clean = (value) =>
  typeof value === "string"
    ? value.replace(/\r\n?/gu, "\n").replace(controlCharacters, "").trim()
    : "";

export function readContactMessage(body = {}) {
  const name = clean(body.name).replace(/\s+/gu, " ");
  const email = clean(body.email).toLowerCase();
  const message = clean(body.message);
  if (
    name.length > 100 ||
    email.length > 254 ||
    !emailPattern.test(email) ||
    message.length < 10 ||
    message.length > 4000
  ) {
    return null;
  }
  const topic = Object.hasOwn(CONTACT_TOPICS, body.topic) ? body.topic : "other";
  return { name, email, topic, message };
}

async function removeExpired(store, now) {
  const cutoff = new Date(now() - CONTACT_RETENTION_MS).toISOString();
  const expired = await store.query(CONTACT_COLLECTION, {
    filters: [{ field: "submittedAt", op: "LESS_THAN", value: cutoff }],
    limit: 50,
  });
  await Promise.all(expired.map(({ id }) => store.delete(CONTACT_COLLECTION, id)));
  return expired.length;
}

async function removeExpiredQuietly(store, now) {
  try {
    await removeExpired(store, now);
  } catch {
    console.warn("[Contact] old messages could not be removed this time.");
  }
}

export function createContactRouter({
  getStore = () => createFirestoreDocumentStore(),
  now = () => Date.now(),
  newTicket = () => randomBytes(4).toString("hex").toUpperCase(),
  limit = 5,
  windowMs = 60 * 60 * 1000,
} = {}) {
  const router = express.Router();
  let store;
  const redirect = (req, res, status, ticket) => {
    const { lang } = req.query;
    res.redirect(
      303,
      `/help?${new URLSearchParams({
        contact: status,
        ...(ticket ? { ticket } : {}),
        ...(typeof lang === "string" && /^[a-z]{2,3}$/u.test(lang) ? { lang } : {}),
      })}#contact`,
    );
  };
  router.post(
    "/",
    rateLimit({
      windowMs,
      limit,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      handler: (req, res) => redirect(req, res, "limited"),
    }),
    express.urlencoded({ extended: false, limit: "40kb", parameterLimit: 8 }),
    async (req, res) => {
      const ticket = newTicket();
      // A field people never see: when it is filled, a bot sent the form.
      if (clean(req.body?.website)) {
        console.warn("[Contact] a bot filled the hidden field; nothing saved.");
        return redirect(req, res, "received", ticket);
      }
      const contact = readContactMessage(req.body);
      if (!contact) return redirect(req, res, "invalid");
      const { lang } = req.query;
      try {
        store ||= getStore();
        await store.set(
          CONTACT_COLLECTION,
          ticket,
          {
            ...contact,
            ticket,
            lang: typeof lang === "string" && /^[a-z]{2,3}$/u.test(lang) ? lang : "bg",
            submittedAt: new Date(now()).toISOString(),
            status: "new",
            noticeVersion,
          },
          { createOnly: true },
        );
      } catch {
        console.warn("[Contact] message storage unavailable.");
        return redirect(req, res, "unavailable");
      }
      console.log(`[Contact] new message, topic ${contact.topic}.`);
      await removeExpiredQuietly(store, now);
      return redirect(req, res, "received", ticket);
    },
  );
  return router;
}

const htmlEscapes = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/gu, (char) => htmlEscapes[char]);
}

export function createContactAdminRouter({
  getStore = () => createFirestoreDocumentStore(),
  now = () => Date.now(),
} = {}) {
  const router = express.Router();
  let store;
  router.get("/", async (_req, res) => {
    res.set("Cache-Control", "private, no-store");
    try {
      store ||= getStore();
      await removeExpiredQuietly(store, now);
      const messages = await store.query(CONTACT_COLLECTION, {
        filters: [{ field: "submittedAt", op: "GREATER_THAN", value: "" }],
        orderBy: { field: "submittedAt", direction: "DESCENDING" },
        limit: 100,
      });
      const rows = messages
        .map(({ data }) => {
          const when = escapeHtml(String(data.submittedAt || "").slice(0, 16).replace("T", " "));
          const topic = escapeHtml(CONTACT_TOPICS[data.topic] || CONTACT_TOPICS.other);
          const subject = encodeURIComponent(`NovariumAI · ${data.ticket || ""}`);
          const name = data.name ? `${escapeHtml(data.name)}<br>` : "";
          return `<tr><td>${when}</td><td>${escapeHtml(data.ticket)}</td><td>${topic}</td><td>${name}<a href="mailto:${escapeHtml(data.email)}?subject=${subject}">${escapeHtml(data.email)}</a></td><td class="contact-message">${escapeHtml(data.message)}</td></tr>`;
        })
        .join("");
      return res.type("html").send(`<!doctype html>
<html lang="bg">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Съобщения от сайта · NovariumAI</title><link rel="stylesheet" href="/plans.css"></head>
<body><main class="plans-shell">
<a href="/">Към NovariumAI</a>
<h1>Съобщения от сайта</h1>
${
  rows
    ? `<p>Последните до 100 съобщения от формуляра за връзка, най-новите първи (време UTC). Пазят се до 1 година.</p><div class="requests-table"><table>
<caption>Получени съобщения</caption><thead><tr><th scope="col">Дата</th><th scope="col">Номер</th><th scope="col">Тема</th><th scope="col">От</th><th scope="col">Съобщение</th></tr></thead>
<tbody>${rows}</tbody></table></div>`
    : "<p>Все още няма съобщения.</p>"
}
</main></body></html>`);
    } catch {
      return res.status(503).send("Съобщенията временно не са достъпни.");
    }
  });
  return router;
}
