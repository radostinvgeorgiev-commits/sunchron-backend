// One splitter for the upload in the browser and for the server, so the two
// never disagree. A file becomes parts at its headings; without headings the
// whole text is one part.
//
// The writer splits only at chapters („Глава 3“, "Chapter III"), exactly as
// before. The other specialists split at chapters, parts, sections, lessons
// and documents in the site's languages, but only when a number follows
// (digits, Roman numerals in capitals, or a word such as „първа“ or "One")
// and the line reads as a heading: „Част 2“, „Урок 3: Дроби“, „Глава първа“,
// "Part 1 Intro". "Част 2 от наема се плаща авансово.", "Lesson I learned:
// never sign blind." and „Глава чесън“ (глава is also a head of garlic)
// stay text.
const CHAPTER = /^\s*(?:глава|chapter|kapitel|capítulo|capitulo|chapitre|capitolo|capitolul|розділ|bölüm)(?=[\s\d.:-]|$)[^\n]{0,80}$/iu;
const CHAPTER_TITLE = /^\s*\S+\s+(?:\d+|[IVXLCDM]+)\b[.:\s-]*/iu;
const PART_WORDS = new Set([
  "глава", "chapter", "kapitel", "capítulo", "capitulo", "chapitre", "capitolo", "capitolul", "capitol",
  "част", "раздел", "урок", "тема", "документ",
  "part", "section", "lesson", "unit", "document",
  "teil", "abschnitt", "lektion", "dokument",
  "parte", "sección", "seccion", "lección", "leccion", "documento",
  "partie", "leçon", "lecon",
  "sezione", "lezione",
  "partea", "secțiunea", "secţiunea", "sectiunea", "lecția", "lecţia", "lectia", "documentul",
  "частина", "розділ", "kısım", "bölüm", "ders",
]);
// Numbers written as words, for „Глава първа“, „Урок втори“, "Part One".
const NUMBER_WORDS = new Set([
  "първа", "втора", "трета", "четвърта", "пета", "шеста", "седма", "осма", "девета", "десета",
  "първи", "втори", "трети", "четвърти", "пети", "шести", "седми", "осми", "девети", "десети",
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
]);
// A word, a number, then nothing, a separator, or a title.
const PART = /^\s*(\p{L}+)\s+(\d{1,3}|\p{L}+)(?:\s*$|\s*([.:)\-–—])\s*(.*)$|\s+(.*)$)/u;
// Roman numerals in capitals only, so "di" or "did" is not one.
const isNumber = (word) => /^\d/u.test(word) || /^[IVXLCDM]{1,7}$/u.test(word) || NUMBER_WORDS.has(word.toLowerCase());
// A title after a space starts like a title: a capital, a digit or a quote.
const TITLE_START = /^[\p{Lu}\d„"«“‘'(¿¡]/u;
// Three words or more that end like a sentence are a sentence, not a title:
// "Abschnitt 3 Satz 1 ist hier nicht anwendbar." A question can be a title.
const SENTENCE = /^\S+(?:\s+\S+){2,}[.!…]["“”»'’)]*$/u;

export function readHeading(line, { writer = true } = {}) {
  if (writer) return CHAPTER.test(line) ? { title: line.trim().replace(CHAPTER_TITLE, "").trim() } : null;
  if (line.trim().length > 90) return null;
  const match = PART.exec(line);
  if (!match || !PART_WORDS.has(match[1].toLowerCase()) || !isNumber(match[2])) return null;
  const [, , , separator, afterSeparator, afterSpace] = match;
  // "Section 1.1 Definitions" is a sub-section, not a new part.
  if (separator === "." && /^\d/u.test(afterSeparator || "")) return null;
  if (afterSpace !== undefined && (!TITLE_START.test(afterSpace) || SENTENCE.test(afterSpace.trim()))) return null;
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
