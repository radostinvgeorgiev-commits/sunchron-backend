// "Откъде знам това": which of the person's own things an answer leans on.
// The model receives the profile, all remembered facts, approved archive
// notes and matching file passages; here we keep only those whose words
// actually show up in the answer, so the line under the answer stays short
// and true. It is a word match, not proof, so the interface says "свързано".
const WORD = /[\p{L}\p{N}]{4,}/gu;
// Common words that would make unrelated facts look connected.
const COMMON = new Set([
  "това", "тази", "този", "тези", "като", "може", "само", "него", "нея", "има", "няма",
  "когато", "защото", "много", "също", "вече", "още", "която", "който", "които", "какво",
  "моят", "моята", "твоят", "твоята", "with", "that", "this", "have", "from", "your",
]);
const MAX_SOURCES = 4;
const LABEL_LENGTH = 70;

function stems(text) {
  return new Set(
    (String(text || "").toLowerCase().match(WORD) || [])
      .filter((word) => !COMMON.has(word))
      .map((word) => word.slice(0, 5)),
  );
}

function shared(answerStems, text) {
  const own = stems(text);
  let count = 0;
  for (const stem of own) if (answerStems.has(stem)) count += 1;
  return { count, size: own.size };
}

function shorten(text) {
  const clean = String(text || "").replace(/\s+/gu, " ").trim();
  return clean.length > LABEL_LENGTH ? `${clean.slice(0, LABEL_LENGTH - 1)}…` : clean;
}

export function describeAnswerSources({
  answer,
  memories = [],
  filePassages = [],
  knowledge = [],
} = {}) {
  const answerStems = stems(answer);
  if (!answerStems.size) return [];
  const found = [];

  const files = new Map();
  for (const { file, text } of Array.isArray(filePassages) ? filePassages : []) {
    const { count } = shared(answerStems, text);
    if (file && count >= 3) files.set(file, Math.max(files.get(file) || 0, count));
  }
  for (const [label, score] of files) found.push({ kind: "file", label: shorten(label), score: score + 100 });

  for (const memory of Array.isArray(memories) ? memories : []) {
    const { count, size } = shared(answerStems, memory?.fact);
    if (count >= 2 && count / Math.max(size, 1) >= 0.4) {
      found.push({ kind: "memory", label: shorten(memory.fact), score: count });
    }
  }

  const archive = new Map();
  for (const item of Array.isArray(knowledge) ? knowledge : []) {
    if (item?.status && item.status !== "approved") continue;
    const { count, size } = shared(answerStems, item?.text);
    const title = item?.sourceTitle || "архив";
    if (count >= 2 && count / Math.max(size, 1) >= 0.4) {
      archive.set(title, Math.max(archive.get(title) || 0, count));
    }
  }
  for (const [label, score] of archive) found.push({ kind: "archive", label: shorten(label), score });

  return found
    .sort((left, right) => right.score - left.score)
    .slice(0, MAX_SOURCES)
    .map(({ kind, label }) => ({ kind, label }));
}
