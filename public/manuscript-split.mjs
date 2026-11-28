// One splitter for the upload in the browser and for the server, so the two
// never disagree. A file becomes parts at its headings; without headings the
// whole text is one part.
//
// The writer splits only at chapters („Глава 3“, "Chapter III"), exactly as
// before. The other specialists split at the same chapter headings and also
// at parts, sections, lessons and documents in the site's languages, but
// only when a number follows and the line reads as a heading: „Част 2“,
// „Урок 3: Дроби“, "Part 1 Intro". "Част 2 от наема се плаща авансово."
// and "Lesson I learned: never sign blind." stay text, and so does
// „Глава ме боли от сутринта.“ for everyone but the writer.
const CHAPTER = /^\s*(?:глава|chapter|kapitel|capítulo|capitulo|chapitre|capitolo|capitolul|розділ|bölüm)(?=[\s\d.:-]|$)[^\n]{0,80}$/iu;
const CHAPTER_TITLE = /^\s*\S+\s+(?:\d+|[IVXLCDM]+)\b[.:\s-]*/iu;
const PART_WORDS = new Set([
  "част", "раздел", "урок", "тема", "документ",
  "part", "section", "lesson", "unit",
  "teil", "abschnitt", "lektion",
  "parte", "sección", "seccion", "lección", "leccion",
  "partie", "leçon", "lecon",
  "sezione", "lezione",
  "partea", "secțiunea", "secţiunea", "sectiunea", "lecția", "lecţia", "lectia",
  "частина", "розділ", "kısım", "bölüm", "ders",
]);
// A word, a number (digits, or Roman numerals in capitals only, so "di" or
// "did" is not one), then nothing, a separator, or a title in capitals.
const PART = /^\s*(\p{L}+)\s+(\d{1,3}|[IVXLCDM]{1,7})(?:\s*$|\s*([.:)\-–—])\s*(.*)$|\s+(.*)$)/u;

// „Глава ме боли от сутринта.“ is a sentence (глава is also "head"): for the
// other specialists a chapter word, then a word in small letters, in a line
// of three words or more that ends like a sentence, stays text.
const SENTENCE = /^\s*\S+\s+\p{Ll}\S*\s+\S.*[.!?…]["“”»']?\s*$/u;

export function readHeading(line, { writer = true } = {}) {
  if (CHAPTER.test(line)) {
    if (!writer && SENTENCE.test(line)) return null;
    return { title: line.trim().replace(CHAPTER_TITLE, "").trim() };
  }
  if (writer || line.trim().length > 90) return null;
  const match = PART.exec(line);
  if (!match || !PART_WORDS.has(match[1].toLowerCase())) return null;
  const [, , , separator, afterSeparator, afterSpace] = match;
  // "Section 1.1 Definitions" is a sub-section, not a new part.
  if (separator === "." && /^\d/u.test(afterSeparator || "")) return null;
  if (afterSpace !== undefined && !/^[\p{Lu}\d„"«(]/u.test(afterSpace)) return null;
  return { title: String(afterSeparator ?? afterSpace ?? "").trim() };
}

export function splitManuscript(text, { writer = true, titleLength = 120, textLength = 50000, maxParts = 60 } = {}) {
  const chapters = [];
  let current = null;
  for (const line of String(text || "").replace(/\r\n?/gu, "\n").split("\n")) {
    const heading = readHeading(line, { writer });
    if (heading) {
      if (current) chapters.push(current);
      current = { title: heading.title.slice(0, titleLength), lines: [] };
    } else {
      current ||= { title: "", lines: [] };
      current.lines.push(line);
    }
  }
  if (current) chapters.push(current);
  return chapters
    .map((chapter) => ({ title: chapter.title, text: chapter.lines.join("\n").trim().slice(0, textLength) }))
    .filter((chapter) => chapter.text)
    .slice(0, maxParts)
    .map((chapter, index) => ({ number: index + 1, ...chapter }));
}
