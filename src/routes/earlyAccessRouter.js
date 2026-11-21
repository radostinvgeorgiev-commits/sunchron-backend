import { createHash } from "node:crypto";
import express from "express";
import { createFirestoreDocumentStore } from "../services/firestoreDocumentStore.js";
import {
  logCampaignEvent,
  readCampaignAttribution,
} from "../services/campaignAttribution.js";

const collection = "synchron-early-access-v1";
const noticeVersion = "early-access-v1";
const emailPattern = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/u;

export function createEarlyAccessRouter({
  getStore = () => createFirestoreDocumentStore(),
} = {}) {
  const router = express.Router();
  let store;
  router.post(
    "/",
    express.urlencoded({ extended: false, limit: "2kb", parameterLimit: 5 }),
    async (req, res) => {
      const attribution = readCampaignAttribution(req.query);
      const redirect = (status) =>
        res.redirect(
          303,
          `/plans?${new URLSearchParams({ request: status, ...attribution })}#early-access`,
        );
      const { email, consent, source } = req.body || {};
      const normalized =
        typeof email === "string" ? email.trim().toLowerCase() : "";
      if (
        normalized.length > 254 ||
        !emailPattern.test(normalized) ||
        consent !== "yes"
      ) {
        return redirect("invalid");
      }

      const id = createHash("sha256").update(normalized).digest("hex");
      try {
        store ||= getStore();
        await store.set(
          collection,
          id,
          {
            email: normalized,
            source: source === "chatgpt" ? "chatgpt" : "direct",
            submittedAt: new Date().toISOString(),
            noticeVersion,
          },
          { createOnly: true },
        );
        logCampaignEvent("campaign_early_access", attribution);
      } catch (error) {
        const duplicate = ["ALREADY_EXISTS", "FAILED_PRECONDITION"].includes(
          error.upstreamErrorStatus,
        );
        if (!duplicate) {
          console.warn("Early access request storage unavailable.");
          return redirect("unavailable");
        }
      }

      return redirect("received");
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

export function createEarlyAccessAdminRouter({
  getStore = () => createFirestoreDocumentStore(),
} = {}) {
  const router = express.Router();
  let store;
  router.get("/", async (_req, res) => {
    res.set("Cache-Control", "private, no-store");
    try {
      store ||= getStore();
      const requests = await store.query(collection, {
        filters: [{ field: "submittedAt", op: "GREATER_THAN", value: "" }],
        orderBy: { field: "submittedAt", direction: "DESCENDING" },
        limit: 100,
      });
      const rows = requests
        .map(({ data }) => {
          const submittedAt = escapeHtml(data.submittedAt?.slice(0, 10));
          const source = data.source === "chatgpt" ? "ChatGPT" : "Сайт";
          return `<tr><td>${escapeHtml(data.email)}</td><td>${submittedAt}</td><td>${source}</td></tr>`;
        })
        .join("");
      return res.type("html").send(`<!doctype html>
<html lang="bg">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Заявки за ранен достъп · SYNCHRON-X</title><link rel="stylesheet" href="/plans.css"></head>
<body><main class="plans-shell">
<a href="/">Към SYNCHRON-X</a>
<h1>Заявки за ранен достъп</h1>
${
  rows
    ? `<p>Последните до 100 заявки, подредени по дата (UTC).</p><div class="requests-table"><table>
<caption>Получени заявки</caption><thead><tr><th scope="col">Имейл</th><th scope="col">Дата</th><th scope="col">Източник</th></tr></thead>
<tbody>${rows}</tbody></table></div>`
    : "<p>Все още няма заявки.</p>"
}
</main></body></html>`);
    } catch {
      return res
        .status(503)
        .send("Заявките за ранен достъп са временно недостъпни.");
    }
  });

  return router;
}
