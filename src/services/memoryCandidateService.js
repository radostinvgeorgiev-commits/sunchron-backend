import { deriveMemoryMetadata } from "./memoryService.js";

const MAX_CANDIDATES = 3;
const MAX_FACT_LENGTH = 240;

// Candidate extraction is deliberately conservative. It proposes only facts
// that are stated directly by the user; it never writes to permanent memory.
const CANDIDATE_PATTERNS = [
  {
    pattern:
      /(?:^|[.!?\n]\s*)(казвам се|името ми е|аз съм)\s+([^.!?\n]{2,180})/iu,
    scope: "personal",
    category: "identity",
    prefix: (match) => `${match[1]} ${match[2]}`,
  },
  {
    pattern:
      /(?:^|[.!?\n]\s*)(предпочитам|харесвам|интересувам се от)\s+([^.!?\n]{2,180})/iu,
    scope: "personal",
    category: "preference",
    prefix: (match) => `${match[1]} ${match[2]}`,
  },
  {
    pattern:
      /(?:^|[.!?\n]\s*)(целта ми е|дългосрочната ми цел е|за мен е важно)\s+([^.!?\n]{2,180})/iu,
    scope: "personal",
    category: "goal",
    prefix: (match) => `${match[1]} ${match[2]}`,
  },
  {
    pattern:
      /(?:^|[.!?\n]\s*)(проектът ми е|проектът се казва|текущата цел на проекта е|работя по проекта)\s+([^.!?\n]{2,180})/iu,
    scope: "project",
    category: "project-fact",
    prefix: (match) => `${match[1]} ${match[2]}`,
  },
];

const SENSITIVE_PATTERN =
  /(?:парол|password|api[_ -]?(?:key|ключ)|токен|token|secret|private\s+key|частен\s+ключ|\bключ\b|имейл|e-mail|телефон|адрес|егн|банка|банков|карта|финанс|кредит|здрав|болест|лекар|медицин|диагноз|http:\/\/|https:\/\/|sk-[a-z0-9]|AIza[0-9a-z_-]+)/iu;

function cleanCandidateFact(value) {
  return String(value || "")
    .replace(/[„“"'’]/gu, "")
    .replace(/\s+/gu, " ")
    .replace(/\s*[,:;.!?]+\s*$/u, "")
    .trim()
    .slice(0, MAX_FACT_LENGTH)
    .trim();
}

function isSafeCandidate(fact) {
  return (
    fact.length >= 6 &&
    fact.length <= MAX_FACT_LENGTH &&
    !SENSITIVE_PATTERN.test(fact) &&
    !/[{}[\]<>]/u.test(fact)
  );
}

export function extractMemoryCandidates({ userText, assistantText = "" } = {}) {
  const text = String(userText || "").trim();
  if (!text || !String(assistantText || "").trim()) return [];

  const candidates = [];
  const seen = new Set();
  for (const definition of CANDIDATE_PATTERNS) {
    const match = text.match(definition.pattern);
    if (!match) continue;
    const fact = cleanCandidateFact(definition.prefix(match));
    const key = fact.toLocaleLowerCase("bg-BG");
    if (!isSafeCandidate(fact) || seen.has(key)) continue;
    seen.add(key);
    const metadata = deriveMemoryMetadata(fact, definition.scope);
    candidates.push({
      fact,
      scope: definition.scope,
      category:
        metadata.category && metadata.category !== "personal-fact"
          ? metadata.category
          : definition.category,
      reason:
        definition.scope === "project"
          ? "Изглежда като устойчив контекст за проекта."
          : "Изглежда като устойчив факт, който може да помогне в бъдещи разговори.",
    });
    if (candidates.length >= MAX_CANDIDATES) break;
  }
  return candidates;
}

export const MEMORY_CANDIDATE_LIMITS = Object.freeze({
  maxCandidates: MAX_CANDIDATES,
  maxFactLength: MAX_FACT_LENGTH,
});
