// „Моите задачи“ in the person's own words (item 3, RADKO's probes 28.11):
// „моите задачи“, „кви задачи имам отворени“ read the list; „добави задача да
// се обадя на банката утре“ adds „Да се обадя на банката“ for tomorrow. The
// work drafts of a project keep their own words („работна задача“, „в
// проекта“, GitHub).

const TIME_ZONE = "Europe/Sofia";

const WORK_WORDS =
  /(?:работн(?:а|ата|и|ите)\s+задач|чернов[аи]\s+(?:на\s+)?задач|проект|github|ги[тд][\s-]*хъб|код(?:а|ът)?(?![\p{L}])|pull\s*request|\bpr\b)/iu;

const READ_WORDS = [
  /(?:^|[^\p{L}])мо(?:ите|и)\s+задачи(?![\p{L}])/iu,
  /(?:^|[^\p{L}])задачите\s+ми(?![\p{L}])/iu,
  /(?:^|[^\p{L}])(?:кви|какви|каки|кои)\s+(?:са\s+)?(?:ми\s+)?задачи(?:\s+(?:имам|ми\s+остават))(?![\p{L}])/iu,
  /(?:^|[^\p{L}])(?:кви|какви|каки|кои)\s+(?:ми\s+)?(?:отворени|незавършени)\s+задачи(?![\p{L}])/iu,
  /(?:^|[^\p{L}])(?:кви|какви|каки|кои)\s+(?:ми\s+)?задачи\s+(?:са\s+)?(?:ми\s+)?(?:отворени|незавършени|остават)(?![\p{L}])/iu,
  /(?:^|[^\p{L}])(?:имам\s+ли|колко)\s+(?:отворени\s+|незавършени\s+)?задачи(?![\p{L}])/iu,
  /(?:^|[^\p{L}])(?:отворени|незавършени)(?:те)?\s+(?:ми\s+)?задачи(?![\p{L}])/iu,
  /\b(?:my\s+(?:open\s+)?(?:tasks|to-?dos?)|what\s+tasks\s+do\s+i\s+have|open\s+tasks)\b/iu,
];

const ADD_WORDS =
  /(?:^|[^\p{L}])(?:добави|запиши|сложи|създай|направи)(?:\s+(?:ми|си|ни))?\s+(?:една\s+|нова\s+)?задача(?:та)?(?![\p{L}])|\badd\s+(?:a\s+)?(?:new\s+)?(?:task|to-?do)\b/iu;

const WEEKDAYS = ["неделя", "понеделник", "вторник", "сряда", "четвъртък", "петък", "събота"];
const ENGLISH_WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = [
  "януари", "февруари", "март", "април", "май", "юни",
  "юли", "август", "септември", "октомври", "ноември", "декември",
];

const PREFIX = "(?:(?:за|до|в|във|на|по|on|by|for)\\s+)?";
const DAY_PATTERNS = [
  { pattern: new RegExp(`${PREFIX}(днес|утре|вдругиден|today|tomorrow)(?![\\p{L}])`, "iu"), kind: "word" },
  {
    pattern: new RegExp(`${PREFIX}(${[...WEEKDAYS, ...ENGLISH_WEEKDAYS].join("|")})(?![\\p{L}])`, "iu"),
    kind: "weekday",
  },
  { pattern: new RegExp(`${PREFIX}(\\d{1,2})\\s+(${MONTHS.join("|")})(?:\\s+(\\d{4}))?(?![\\p{L}])`, "iu"), kind: "month" },
  { pattern: new RegExp(`${PREFIX}(\\d{1,2})[./](\\d{1,2})(?:[./](\\d{4}))?(?![\\d])`, "u"), kind: "numbers" },
];

function sofiaToday(now) {
  return new Date(now).toLocaleDateString("sv-SE", { timeZone: TIME_ZONE });
}

function shiftDay(day, days) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function realDay(year, month, day) {
  const value = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : "";
}

// A date without a year is the next one from today on.
function nextDay(today, month, day, year) {
  if (year) return realDay(Number(year), month, day);
  const thisYear = Number(today.slice(0, 4));
  const candidate = realDay(thisYear, month, day);
  return candidate && candidate >= today ? candidate : realDay(thisYear + 1, month, day);
}

// The day the person named, and the words without it.
export function readTodoDay(text, now = Date.now()) {
  const today = sofiaToday(now);
  for (const { pattern, kind } of DAY_PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;
    let due = "";
    if (kind === "word") {
      const word = match[1].toLowerCase();
      due = shiftDay(today, { днес: 0, today: 0, утре: 1, tomorrow: 1, вдругиден: 2 }[word]);
    } else if (kind === "weekday") {
      const word = match[1].toLowerCase();
      const target = WEEKDAYS.includes(word) ? WEEKDAYS.indexOf(word) : ENGLISH_WEEKDAYS.indexOf(word);
      const current = new Date(`${today}T00:00:00Z`).getUTCDay();
      due = shiftDay(today, ((target - current + 7) % 7) || 7);
    } else if (kind === "month") {
      due = nextDay(today, MONTHS.indexOf(match[2].toLowerCase()) + 1, Number(match[1]), match[3]);
    } else {
      due = nextDay(today, Number(match[2]), Number(match[1]), match[3]);
    }
    if (!due) continue;
    const rest = `${text.slice(0, match.index)} ${text.slice(match.index + match[0].length)}`;
    return { due, rest: rest.replace(/\s+/gu, " ").trim() };
  }
  return { due: "", rest: text.trim() };
}

function taskText(words) {
  const text = words
    .replace(/^[\s:,;–—-]+/u, "")
    .replace(/[\s,;:–—-]+$/u, "")
    .replace(/[.!?]+$/u, "")
    .trim();
  return text ? `${text[0].toLocaleUpperCase("bg")}${text.slice(1)}` : "";
}

// { type: "read" } | { type: "add", text, due } | null
export function readTodoWords(message, { now = Date.now() } = {}) {
  const text = typeof message === "string" ? message.trim() : "";
  if (!text || WORK_WORDS.test(text)) return null;
  const add = ADD_WORDS.exec(text);
  if (add) {
    const words = text.slice(add.index + add[0].length);
    const { due, rest } = readTodoDay(words, now);
    return { type: "add", text: taskText(rest), due };
  }
  if (READ_WORDS.some((pattern) => pattern.test(text))) return { type: "read" };
  return null;
}
