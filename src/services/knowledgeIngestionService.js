const MAX_DOCUMENTS = 100;
const MAX_DOCUMENT_LENGTH = 12_000;
const MAX_CANDIDATES = 200;
const MAX_CANDIDATE_LENGTH = 1_200;

const KNOWLEDGE_CATEGORIES = new Set(["fact", "decision", "idea", "obsolete"]);
const KNOWLEDGE_SCOPES = new Set(["personal", "project"]);

function invalidKnowledgeInput(message) {
  const error = new Error(message);
  error.code = "INVALID_KNOWLEDGE";
  error.status = 400;
  return error;
}

function cleanText(value, maxLength, label) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "";
  if (text.length > maxLength) {
    throw invalidKnowledgeInput(`${label} е прекалено дълго.`);
  }
  return text.replace(/\s+/gu, " ").trim();
}

function normalizedText(value) {
  return String(value || "")
    .toLocaleLowerCase("bg-BG")
    .replace(/[„“"'’.,!?;:()[\]{}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function messageText(message) {
  if (typeof message?.text === "string") return message.text;
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content?.parts)) {
    return content.parts.filter((part) => typeof part === "string").join(" ");
  }
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "string" ? part : typeof part?.text === "string" ? part.text : "",
      )
      .filter(Boolean)
      .join(" ");
  }
  return typeof content?.text === "string" ? content.text : "";
}

function roleOf(message) {
  const role = String(message?.role || message?.author?.role || "").toLowerCase();
  if (role === "assistant" || role === "model") return "assistant";
  if (role === "user" || role === "human") return "user";
  return "document";
}

function chatGptConversationMessages(conversation) {
  const mapping = conversation?.mapping;
  if (!mapping || typeof mapping !== "object") return [];
  return Object.values(mapping)
    .map((node) => node?.message)
    .filter(Boolean)
    .map((message) => ({
      role: roleOf(message),
      text: messageText(message),
      createdAt: message?.create_time
        ? new Date(Number(message.create_time) * 1000).toISOString()
        : null,
    }))
    .filter((message) => message.text.trim())
    .sort((left, right) => String(left.createdAt || "").localeCompare(String(right.createdAt || "")));
}

function simpleConversationMessages(conversation) {
  if (!Array.isArray(conversation?.messages)) return [];
  return conversation.messages
    .map((message) => ({
      role: roleOf(message),
      text: messageText(message),
      createdAt: message?.createdAt || message?.create_time || null,
    }))
    .filter((message) => message.text.trim());
}

function normalizeDocument(document, index) {
  const sourceId = cleanText(
    document?.id || document?.sourceId || `document-${index + 1}`,
    200,
    "идентификаторът на документа",
  );
  const title =
    cleanText(document?.title || document?.name || `Архивен документ ${index + 1}`, 300, "заглавието") ||
    `Архивен документ ${index + 1}`;
  const sourceType = cleanText(document?.sourceType || document?.type || "archive", 80, "типът") || "archive";
  const messages = Array.isArray(document?.messages)
    ? simpleConversationMessages(document)
    : document?.mapping
      ? chatGptConversationMessages(document)
      : [];
  const directText = cleanText(document?.text || document?.content || "", MAX_DOCUMENT_LENGTH, "текстът");
  if (!messages.length && directText) {
    messages.push({ role: "document", text: directText, createdAt: document?.createdAt || null });
  }
  if (!messages.length) return null;
  return Object.freeze({
    sourceId,
    title,
    sourceType,
    createdAt: document?.createdAt || document?.create_time || null,
    messages: Object.freeze(messages),
  });
}

export function normalizeArchiveDocuments(input) {
  const rawDocuments = Array.isArray(input)
    ? input
    : Array.isArray(input?.documents)
      ? input.documents
      : Array.isArray(input?.conversations)
        ? input.conversations
        : input && typeof input === "object"
          ? [input]
          : [];
  if (rawDocuments.length > MAX_DOCUMENTS) {
    throw invalidKnowledgeInput(
      `Архивът надвишава безопасния лимит от ${MAX_DOCUMENTS} документа.`,
    );
  }
  return Object.freeze(
    rawDocuments.map(normalizeDocument).filter(Boolean),
  );
}

export function classifyKnowledgeText(text) {
  const normalized = normalizedText(text);
  if (/(?:стар(?:ия|ото|и)?|неактуал|не използваме|изтрий|махни|отпада|заменяме)/iu.test(normalized)) {
    return "obsolete";
  }
  if (/(?:решихме|решение|приоритет|оставяме|избираме|готово когато|прието)/iu.test(normalized)) {
    return "decision";
  }
  if (/(?:идея|може да|би било|искам(?:е)? да|предлагам|план)/iu.test(normalized)) {
    return "idea";
  }
  return "fact";
}

function inferScope(text) {
  return /(?:(?:^|[^\p{L}])аз(?:$|[^\p{L}])|(?:^|[^\p{L}])ми(?:$|[^\p{L}])|мо(?:ят|ята|ето|ите)|за мен|здрав|хранен|трениров|телефон|часовник)/iu.test(text)
    ? "personal"
    : "project";
}

function splitCandidateText(text) {
  const clean = String(text || "")
    .replace(/\r\n/gu, "\n")
    .split(/\n{2,}|(?<=[.!?])\s+(?=[А-ЯA-Z])/u)
    .map((part) => part.trim())
    .filter(Boolean);
  return clean.length ? clean : [String(text || "").trim()];
}

function candidateFromText(text, document, index) {
  const clean = cleanText(text, MAX_CANDIDATE_LENGTH, "кандидатът");
  if (!clean || clean.length < 8) return null;
  const category = classifyKnowledgeText(clean);
  const scope = inferScope(clean);
  return Object.freeze({
    id: `${document.sourceId}-${index + 1}`.replace(/[^A-Za-z0-9_-]/gu, "-").slice(0, 180),
    text: clean,
    category,
    scope,
    sourceId: document.sourceId,
    sourceTitle: document.title,
    sourceType: document.sourceType,
    sourceCreatedAt: document.createdAt,
    confidence: "heuristic",
    status: "proposed",
  });
}

export function buildKnowledgePreview(input, options = {}) {
  const documents = normalizeArchiveDocuments(input);
  const requestedScope = KNOWLEDGE_SCOPES.has(options.scope) ? options.scope : null;
  const seen = new Set();
  const candidates = [];
  for (const document of documents) {
    for (const message of document.messages) {
      // Assistant output is untrusted model text. Only user-authored messages
      // and explicitly supplied documents may become knowledge candidates.
      if (message.role === "assistant") continue;
      for (const part of splitCandidateText(message.text)) {
        const candidate = candidateFromText(part, document, candidates.length);
        if (!candidate) continue;
        if (requestedScope && candidate.scope !== requestedScope) continue;
        const key = normalizedText(candidate.text);
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push(candidate);
        if (candidates.length >= MAX_CANDIDATES) break;
      }
      if (candidates.length >= MAX_CANDIDATES) break;
    }
    if (candidates.length >= MAX_CANDIDATES) break;
  }
  const counts = Object.fromEntries(
    [...KNOWLEDGE_CATEGORIES].map((category) => [
      category,
      candidates.filter((candidate) => candidate.category === category).length,
    ]),
  );
  return Object.freeze({
    documentCount: documents.length,
    candidateCount: candidates.length,
    candidates: Object.freeze(candidates),
    counts: Object.freeze(counts),
    truncated: candidates.length >= MAX_CANDIDATES,
  });
}

export function normalizeKnowledgeCandidates(items) {
  if (!Array.isArray(items) || !items.length || items.length > 30) {
    throw invalidKnowledgeInput("Избери между един и 30 кандидата за импорт.");
  }
  return Object.freeze(
    items.map((item, index) => {
      const text = cleanText(item?.text, MAX_CANDIDATE_LENGTH, "кандидатът");
      const category = KNOWLEDGE_CATEGORIES.has(item?.category) ? item.category : classifyKnowledgeText(text);
      const scope = KNOWLEDGE_SCOPES.has(item?.scope) ? item.scope : inferScope(text);
      if (!text || text.length < 8) {
        throw invalidKnowledgeInput(`Кандидат ${index + 1} е празен.`);
      }
      return Object.freeze({
        id: cleanText(item?.id || `candidate-${index + 1}`, 180, "идентификаторът") || `candidate-${index + 1}`,
        text,
        category,
        scope,
        sourceId: cleanText(item?.sourceId || "archive", 200, "източникът") || "archive",
        sourceTitle: cleanText(item?.sourceTitle || "Архив", 300, "заглавието") || "Архив",
        sourceType: cleanText(item?.sourceType || "archive", 80, "типът") || "archive",
        sourceCreatedAt: item?.sourceCreatedAt || null,
        confidence: item?.confidence === "high" || item?.confidence === "medium" ? item.confidence : "heuristic",
        status: "proposed",
      });
    }),
  );
}

export const KNOWLEDGE_LIMITS = Object.freeze({
  maxDocuments: MAX_DOCUMENTS,
  maxCandidates: MAX_CANDIDATES,
  maxImportCandidates: 30,
  maxCandidateLength: MAX_CANDIDATE_LENGTH,
});
