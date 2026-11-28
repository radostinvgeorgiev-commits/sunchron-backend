import { requestAiText } from "./novariumService.js";
import { createFirestoreDocumentStore } from "./firestoreDocumentStore.js";
import { BookMemoryError, runChapterCheck } from "./bookMemoryService.js";

// The free chapter check on the start page: no sign-in and no e-mail. The
// person writes what is true in the book and pastes a chapter; nothing is
// saved, only a count per day so the whole site stays within its AI budget.
export const FREE_CHECK_COLLECTION = "synchron-free-chapter-check-v1";
export const FREE_CHECK_LIMITS = Object.freeze({
  facts: 3000,
  factLines: 30,
  factText: 300,
  chapter: 15000,
  perDay: 200,
});

const cleanLine = (value) =>
  String(value || "")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/^\s*(?:[-*•]|\d+[.)])\s*/u, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, FREE_CHECK_LIMITS.factText);

// One fact per line; the model sees them as rules of the book.
export function parseFreeFacts(text) {
  return String(text || "")
    .slice(0, FREE_CHECK_LIMITS.facts)
    .split(/\r?\n/u)
    .map(cleanLine)
    .filter(Boolean)
    .slice(0, FREE_CHECK_LIMITS.factLines)
    .map((line, index) => ({ id: `f${index + 1}`, kind: "rule", name: "", text: line, fromChapter: 1 }));
}

export function createFreeChapterCheck({
  store,
  env = process.env,
  askAi = requestAiText,
  today = () => new Date().toISOString().slice(0, 10),
} = {}) {
  let runtimeStore = store;
  const db = () => (runtimeStore ||= createFirestoreDocumentStore({ env }));

  async function check({ facts, text } = {}) {
    const known = parseFreeFacts(facts);
    if (!known.length) throw new BookMemoryError("Напиши поне един факт от книгата.");
    const source =
      typeof text === "string"
        ? text.replace(/\r\n?/gu, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, " ").slice(0, FREE_CHECK_LIMITS.chapter).trim()
        : "";
    if (!source) throw new BookMemoryError("Постави текста на главата.");
    const day = today();
    const row = await db().get(FREE_CHECK_COLLECTION, "count");
    const count = row?.data?.day === day ? Number(row.data.count) || 0 : 0;
    if (count >= FREE_CHECK_LIMITS.perDay) {
      throw new BookMemoryError(
        "Безплатните проверки за днес свършиха. Влез безплатно, за да провериш главата си сега.",
        429,
        "FREE_CHECK_DAILY_LIMIT",
      );
    }
    await db().commitOperations([
      { type: "set", collection: FREE_CHECK_COLLECTION, id: "count", data: { day, count: count + 1 } },
    ]);
    const result = await runChapterCheck({ facts: known, source, askAi, env, pickFacts: (all) => all });
    return { ...result, issues: result.issues.map(({ fact, quote, why }) => ({ fact, quote, why })) };
  }

  return { check };
}

let defaultService;
export function getFreeChapterCheck() {
  return (defaultService ||= createFreeChapterCheck());
}
