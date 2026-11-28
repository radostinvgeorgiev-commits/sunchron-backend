import { VIDEOS_FOR_MEMBERS } from "../routes/videoGenerationRouter.js";
import {
  codeBlocksOfLines,
  isNextStepLine,
  nextLineStep,
  nextStepLineIndexes,
  ownNextStep,
} from "./projectConversationContextService.js";
import { PUBLIC_IMAGE_CREDITS, PUBLIC_VIDEO_CREDITS } from "./publicAiBudget.js";
import { ASKS_BACK, isBareAgreement, isYesWord, shortMessageWords } from "./shortYes.js";
import { resolveVertexAiProjectId } from "./vertexAiGeminiService.js";

// Pictures and video from the chat. The answering model cannot draw in its
// text; it writes one ready description per item on its own line, starting
// with "Картинка 1:" or "Видео:" ("Image 1:"/"Video:" on other page
// languages), and ends with a Next line that offers to make them. The page
// shows a card with a button for each and makes them, on a press or on the
// person's short yes to that offer, with the same code as the "+" menu (POST
// /api/images and /api/videos), whose routes reserve the units and refund a
// failed video. Nothing here makes a picture or a video or moves units.

export const MAX_CHAT_IMAGES = 4;
export const MAX_CHAT_VIDEOS = 1;
const MAX_ITEMS = { image: MAX_CHAT_IMAGES, video: MAX_CHAT_VIDEOS };
const CREDITS = { image: PUBLIC_IMAGE_CREDITS, video: PUBLIC_VIDEO_CREDITS };
const KINDS = Object.freeze(["image", "video"]);
// The longest description each generator takes (cleanImagePrompt and
// cleanVideoPrompt cut there too).
const PROMPT_LIMITS = { image: 1500, video: 2000 };
const MIN_DESCRIPTION_LENGTH = 10;
// Only an answer's last 100,000 characters are read, as for its Next line, so
// a crafted request cannot make the server split megabytes into lines.
const READ_LIMIT = 100_000;

// What this account can make here, by the same checks as the generators and
// the video route: pictures need the OpenAI key, video the Gemini key or
// Vertex AI, and a member gets video only while it is open to every account.
export function mediaAvailability(env = process.env, { member = false } = {}) {
  return {
    images: Boolean(env?.OPENAI_API_KEY),
    video:
      Boolean(env?.GEMINI_API_KEY || resolveVertexAiProjectId(env)) &&
      (!member || VIDEOS_FOR_MEMBERS),
  };
}

// ── Descriptions ───────────────────────────────────────────────────────────

// The label words of a description line, in the page languages. Only a
// capital first letter with the rest in lower case is a label: an all-caps
// "ВИДЕО:" or "VIDEO:" is the column of a script, not an order, and a
// lower-case "image:" is a line of configuration.
const MEDIA_LABELS = new Map([
  ["Картинка", "image"],
  ["Изображение", "image"],
  ["Снимка", "image"],
  ["Видео", "video"],
  ["Клип", "video"],
  ["Image", "image"],
  ["Picture", "image"],
  ["Photo", "image"],
  ["Video", "video"],
  ["Clip", "video"],
  ["Bild", "image"],
  ["Imagen", "image"],
  ["Vídeo", "video"],
  ["Vidéo", "video"],
  ["Immagine", "image"],
  ["Imagine", "image"],
]);

// What may come before a label: indentation, a list marker ("-", "*", "•",
// "+", "1.", "1)"), heading marks ("#" to "######") and an emphasis mark
// ("**", "*", "__", "_"). Every part is optional, so it always matches.
const LABEL_START = /[ \t]*(?:(?:[-*•+]|\d{1,3}[.)])[ \t]+)?(?:#{1,6}[ \t]+)?(\*\*|__|\*|_)?/uy;
const LABEL_WORD = /[\p{L}\p{M}]+/uy;
// After the label word: a number ("1", "#1", "№1"), a "(…)" of at most 60
// characters and a dash subtitle ("– корица", "- cover") of at most 60, each
// optional, then the closing emphasis and the colon. Only short bounded runs,
// so a crafted line stays linear.
const LABEL_END =
  /(?:[ \t]{0,3}[#№]?[ \t]{0,2}(\d{1,2}))?(?:[ \t]{0,3}\([^()\n]{0,60}\))?(?:[ \t]{0,3}[-–—][ \t]{0,3}[^:：*_\n]{1,60})?[ \t]{0,3}(?:\*\*|__|\*|_)?[ \t]{0,3}[:：]/uy;
// The columns of a video script. An answer with one of them is a script, and
// its "Видео:" lines are scenes to film, not descriptions to make.
const SCRIPT_LABEL =
  /(текст на екрана|on-screen text|аудио|звук|глас|диктор|audio|sound|voice|vo|narrator)(?:\*\*|__|\*|_)?[ \t]{0,3}[:：]/iuy;
// A list marker before a description taken from the line below its label.
const LIST_MARKER = /^[ \t]*(?:[-*•+]|\d{1,3}[.)])[ \t]+/u;

// Where the label of a line starts, past any list marker, heading or
// emphasis, and the emphasis mark that opened before it.
function labelStart(line) {
  LABEL_START.lastIndex = 0;
  const match = LABEL_START.exec(line);
  return { at: LABEL_START.lastIndex, emphasis: match[1] || "" };
}

// A description label ("**Картинка 2:**", "### Image 1:", "Видео (9:16):"):
// its kind, its number and the text after it; null when there is none.
function readMediaLabel(line) {
  const { at, emphasis } = labelStart(line);
  LABEL_WORD.lastIndex = at;
  const word = LABEL_WORD.exec(line);
  const kind = word && MEDIA_LABELS.get(word[0].normalize("NFC"));
  if (!kind) return null;
  LABEL_END.lastIndex = LABEL_WORD.lastIndex;
  const end = LABEL_END.exec(line);
  if (!end) return null;
  let text = line.slice(LABEL_END.lastIndex);
  // The emphasis may close after the colon: "**Картинка 1:** …".
  if (emphasis && text.trimStart().startsWith(emphasis)) text = text.trimStart().slice(emphasis.length);
  return { kind, number: end[1] ? Number(end[1]) : null, text };
}

// The script column a line starts with ("Звук", "Audio"…), or "".
function scriptLabel(line) {
  SCRIPT_LABEL.lastIndex = labelStart(line).at;
  return SCRIPT_LABEL.exec(line)?.[1] || "";
}

// Bold marks and wrapping backticks are formatting, not part of the picture.
// The backticks are counted, not matched with a backreference, so a crafted
// line of them stays linear.
function cleanDescription(text) {
  const description = String(text)
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\*\*/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  const ticks = description.match(/^`+/u)?.[0].length || 0;
  const inner = description.slice(ticks, description.length - ticks);
  const wrapped =
    ticks > 0 &&
    description.length > 2 * ticks &&
    description.endsWith("`".repeat(ticks)) &&
    !inner.includes("`");
  return wrapped ? inner.trim() : description;
}

const URL_IN_TEXT = /(?:https?:\/\/|www\.)\S*/giu;
const STARTS_WITH_URL = /^(?:https?:\/\/|www\.)/iu;
const STARTS_WITH_FILE = /^\S+\.(?:mp4|mov|webm|png|jpe?g|webp|gif)(?![\p{L}\p{N}])/iu;

// A link or a file is not a picture to make ("Видео: novarium-video.mp4 …" is
// a clip that exists). A web address inside a description, as an ad shows
// "www.cloudaicore.com", stays.
function isDescription(prompt) {
  return (
    prompt.replace(URL_IN_TEXT, "").trim().length >= MIN_DESCRIPTION_LENGTH &&
    !STARTS_WITH_URL.test(prompt) &&
    !STARTS_WITH_FILE.test(prompt)
  );
}

// The description lines of an answer's lines, outside code (the fence rule
// of nextStepLineIndexes decides what is code), in order: { kind, number,
// text, lines }. When a label has nothing after its colon, the next non-blank
// line is its description if it is plain text (a list marker before it is
// left out). `script` is the first script column the answer has ("Звук"), or
// "".
function descriptionLines(lines) {
  const textLines = nextStepLineIndexes(lines, (line) => Boolean(line.trim()));
  const found = [];
  let script = "";
  for (let position = 0; position < textLines.length; position += 1) {
    const index = textLines[position];
    const column = scriptLabel(lines[index]);
    if (column) {
      script ||= column;
      continue;
    }
    const label = readMediaLabel(lines[index]);
    if (!label) continue;
    const item = { ...label, lines: [index] };
    const next = textLines[position + 1];
    if (
      !cleanDescription(label.text) &&
      next !== undefined &&
      lines.slice(index + 1, next).every((line) => !line.trim()) &&
      isPlainLine(lines[next])
    ) {
      item.text = lines[next].replace(LIST_MARKER, "");
      item.lines.push(next);
      position += 1;
    }
    found.push(item);
  }
  return { found, script };
}

// A Markdown heading ("## Видео") starts the next part of the answer, so it
// is never the description of an empty label above it (review r2).
const HEADING = /^[ \t]{0,3}#{1,6}(?:[ \t]|$)/u;

function isPlainLine(line) {
  return !HEADING.test(line) && !readMediaLabel(line) && !scriptLabel(line) && !isNextStepLine(line);
}

// The descriptions of an answer as mediaOffer reads them: `items` ({ kind,
// prompt, number? } in order), `labelled` (how many description labels the
// answer has at all) and `script` (the script column that made them none).
function readDescriptions(text) {
  if (typeof text !== "string") return { items: [], labelled: 0, script: "" };
  const lines = text.slice(-READ_LIMIT).split("\n");
  const { found, script } = descriptionLines(lines);
  if (script) return { items: [], labelled: found.length, script: found.length ? script : "" };
  const items = [];
  for (const { kind, number, text: raw } of found) {
    const prompt = cleanDescription(raw);
    if (!isDescription(prompt)) continue;
    // Cut where the generator cuts, without a space left at the end: the
    // page tells its items apart by the trimmed description.
    items.push({ kind, prompt: prompt.slice(0, PROMPT_LIMITS[kind]).trim(), ...(number ? { number } : {}) });
  }
  return { items, labelled: found.length, script: "" };
}

// The descriptions of an answer, in its order: { kind, prompt } and the
// label's own number when it has one. A script, a link, a file name or a
// line inside code is none; an answer with a script column has none at all.
// Every description is returned; mediaOffer keeps what this account can make.
export function extractMediaProposals(text) {
  return readDescriptions(text).items;
}

// The answer without its description lines: what the tool detector and the
// planner may read of it, so a "GitHub" or "Gmail" in a picture never starts
// a tool.
export function withoutDescriptionLines(text) {
  const lines = String(text || "").slice(-READ_LIMIT).split("\n");
  const drop = new Set(descriptionLines(lines).found.flatMap((item) => item.lines));
  return lines
    .filter((line, index) => !drop.has(index))
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

// ── The answer's own Next step ─────────────────────────────────────────────

// The step's words in lower case: letters with their accents, or digits.
// "I'll" is "i", "ll"; "Di'" is "di"; "2-те" is "2", "те".
function stepWords(step) {
  return String(step || "").normalize("NFC").toLowerCase().match(/[\p{L}\p{M}]+|\p{N}+/gu) || [];
}

const forms = (stem, endings) => endings.map((ending) => `${stem}${ending}`);
const RISUVAM = ["ам", "аш", "а", "аме", "ате", "ат", "ай", "айте", "ах", "ахме", "ахте", "аха", "ал", "ала", "ало", "али"];
// Verbs of making, as whole words. Bulgarian forms are a stem and its verb
// endings ("правя", "направя", "нарисувам", "създам", "създавам",
// "генерирам"), so "правило", "правоъгълни" and "правна" are none.
const MAKE_FORMS = new Set([
  ...forms("прав", ["я", "иш", "и", "им", "ите", "ят", "ете", "ех", "еше", "ехме", "ехте", "еха"]),
  ...forms("направ", ["я", "иш", "и", "им", "ите", "ят", "ете", "их", "ихме", "ихте", "иха", "ил", "ила", "ило", "или"]),
  ...forms("рисув", RISUVAM),
  ...forms("нарисув", RISUVAM),
  ...forms("генерир", RISUVAM),
  ...forms("създа", [
    "м", "ш", "де", "дем", "дете", "дат", "й", "йте", "дох", "дохме", "дохте", "доха", "л", "ла", "ло", "ли",
    "вам", "ваш", "ва", "ваме", "вате", "ват", "вай", "вайте",
  ]),
  "make", "draw", "create", "generate", "render",
  "erstelle", "mache", "zeichne", "generiere",
  "hago", "creo", "genero", "dibujo",
  "fais", "crée", "génère", "dessine",
  "faccio", "disegno",
  "fac", "creez", "generez", "desenez",
  // The future the model may translate the line into („Di «sí» y haré las
  // imágenes“, „Dis « oui » et je ferai l'image“, review r5).
  "haré", "crearé", "generaré", "dibujaré", "ferai", "créerai", "générerai", "dessinerai",
  "farò", "creerò", "genererò", "disegnerò",
]);
// The Romanian infinitives, verbs of making only right after the future's
// „voi“ („voi face imaginile“): alone, "face" and "crea" are other words.
const AFTER_VOI = new Set(["face", "crea", "genera", "desena"]);
// Whether the word at `index` is a verb of making.
const isMakeVerb = (words, index) =>
  MAKE_FORMS.has(words[index]) || (AFTER_VOI.has(words[index]) && words[index - 1] === "voi");
// Pictures and video as whole words, with the kind each names: Bulgarian and
// Romanian forms with their endings ("картинките", "видеото", "imaginile"),
// so "видеоконференцията" and "imaginative" are none. Bulgarian typed in
// Latin letters ("kartinkite", "videoto") counts too.
const MEDIA_FORMS = new Map([
  ...[
    ...forms("картинк", ["а", "и", "ата", "ите"]),
    ...forms("изображени", ["е", "я", "ето", "ята"]),
    ...forms("снимк", ["а", "и", "ата", "ите"]),
    ...forms("kartink", ["a", "i", "ata", "ite"]),
    ...forms("snimk", ["a", "i", "ata", "ite"]),
    ...forms("imagin", ["e", "i", "ea", "ile", "ii", "ilor"]),
    "image", "images", "picture", "pictures", "photo", "photos", "bild", "bilder", "imagen", "imágenes",
    "imagenes", "immagine", "immagini",
  ].map((word) => [word, "image"]),
  ...[
    ...forms("видео", ["", "то"]),
    ...forms("видеа", ["", "та"]),
    ...forms("клип", ["", "а", "ът", "ове", "овете"]),
    ...forms("видеоклип", ["", "а", "ът", "ове", "овете"]),
    ...forms("video", ["", "s", "to", "ul", "uri", "urile", "clip", "clipul", "clipuri", "clipurile"]),
    "vídeo", "vídeos", "vidéo", "vidéos", "clip", "clips",
  ].map((word) => [word, "video"]),
]);
// The forms of one picture or one video: a yes that names one ("направи
// картинката") means one item of that kind.
const SINGLE_MEDIA = new Set([
  "картинка", "картинката", "изображение", "изображението", "снимка", "снимката", "kartinka", "kartinkata",
  "snimka", "snimkata", "видео", "видеото", "videoto", "клип", "клипа", "клипът", "видеоклип", "видеоклипа",
  "видеоклипът", "image", "picture", "photo", "video", "clip", "bild", "imagen", "vídeo", "vidéo",
  "immagine", "imagine", "imaginea", "videoul", "videoclip", "videoclipul",
]);
const OBJECT_PRONOUNS = new Set(["ги", "го", "я", "them", "it", "sie", "es", "las", "los", "la", "lo", "les", "le", "li", "o", "îl"]);
// Words that may stand between the verb and the media and name no items:
// articles, "this", "all", "your", "new"…
const PLAIN_DETERMINERS = new Set([
  "всички", "всичките", "те", "тази", "този", "това", "тези", "още", "нова", "нови", "новата", "новите",
  "новото", "ново", "новия",
  "the", "this", "that", "these", "those", "all", "new", "your", "my", "our",
  "das", "die", "den", "der", "alle", "neue", "neuen",
  "el", "la", "los", "las", "unos", "unas", "nuevo", "nueva", "nuevos", "nuevas", "todos", "todas",
  "le", "les", "l", "des", "nouveau", "nouvelle", "nouveaux", "nouvelles", "tous", "toutes",
  "il", "lo", "i", "gli", "nuovo", "nuova", "nuovi", "nuove", "tutti", "tutte",
  "noi", "toate", "cele", "cel", "cea",
]);
// How many items a word before the media counts ("двете картинки", "a
// picture", "the two pictures").
const COUNT_WORDS = new Map([
  ...["една", "едно", "един", "a", "an", "one", "ein", "eine", "einen", "un", "una", "uno", "une", "o"].map((word) => [word, 1]),
  ...["две", "двете", "два", "двата", "two", "both", "zwei", "beide", "beiden", "dos", "ambos", "ambas", "deux", "due", "două"].map(
    (word) => [word, 2],
  ),
  ...["три", "трите", "three", "drei", "tres", "trois", "tre", "trei"].map((word) => [word, 3]),
  ...["четири", "четирите", "four", "vier", "cuatro", "quatre", "quattro", "patru"].map((word) => [word, 4]),
]);
// Which item a word before the media names ("първата картинка", "the first
// picture"): its number.
const ORDINAL_WORDS = new Map(
  [
    ["първата", "първото", "първия", "първият", "first", "erste", "erstes", "erster", "primer", "primera", "primero", "premier", "première", "primo", "prima", "primul"],
    ["втората", "второто", "втория", "вторият", "second", "zweite", "zweites", "zweiter", "segunda", "segundo", "deuxième", "seconde", "secondo", "seconda", "doua", "doilea"],
    ["третата", "третото", "третия", "третият", "third", "dritte", "drittes", "dritter", "tercer", "tercera", "tercero", "troisième", "terzo", "terza", "treia", "treilea"],
    ["четвъртата", "четвъртото", "четвъртия", "четвъртият", "fourth", "vierte", "viertes", "vierter", "cuarta", "cuarto", "quatrième", "quarto", "quarta", "patra", "patrulea"],
    ["петата", "петото", "петия", "fifth", "fünfte", "quinta", "quinto", "cinquième", "cincea"],
  ].flatMap((words, at) => words.map((word) => [word, at + 1])),
);
// Words that leave it unclear which items are meant ("първите", "the last",
// "другата").
const UNCLEAR_WORDS = new Set([
  "първите", "вторите", "последната", "последното", "последния", "последните", "другата", "другите", "другото",
  "last", "other", "ersten", "letzte", "letzten", "primeros", "primeras", "último", "última", "premiers",
  "premières", "dernier", "dernière", "primi", "prime", "ultimo", "ultima", "primele", "ultimul",
]);
// The words that join two media ("картинките и видеото").
const AND_WORDS = new Set(["и", "and", "und", "y", "et", "e", "și", "si"]);
// "only" before the media („правя само картинките“, "make only the video").
const ONLY_WORDS = new Set(["само", "only", "just", "nur", "solo", "seulement", "doar"]);
const MAX_NOUN_PHRASES = 8;

const isNumber = (word) => /^\p{N}+$/u.test(word || "") && Number.isSafeInteger(Number(word));

// The index of the next ordinal of the same noun after an ordinal ("първата
// и втората картинка", "the first, second and third pictures", "the first
// and the second picture"; the comma is no word), or 0.
function nextOrdinal(words, at, and) {
  if (ORDINAL_WORDS.has(words[at])) return at;
  if (!and.has(words[at])) return 0;
  if (ORDINAL_WORDS.has(words[at + 1])) return at + 1;
  return PLAIN_DETERMINERS.has(words[at + 1]) && ORDINAL_WORDS.has(words[at + 2]) ? at + 2 : 0;
}

// One media noun with at most two words before it (articles, "all", counts
// and ordinals: "картинките", "двете картинки", "първата картинка", "the two
// pictures"), or ordinals joined by "and" right before it ("първата и
// втората картинка"), and the numbers after it ("картинка 1", "картинки 1 и
// 2", "picture 1"). An "and" may open it, as in a pair („и картинките, и
// видеото“, „et l'image et la vidéo“). Returns its kind, the index after it,
// the count before it (0 when none), the numbers it names, and whether it is
// unclear which items it means; null when there is no media noun there.
function nounAt(words, start, and = AND_WORDS) {
  const phrase = { kind: "", end: start, count: 0, numbers: [], unclear: false };
  let at = and.has(words[start]) ? start + 1 : start;
  let limit = at + 2;
  for (; at < limit && !MEDIA_FORMS.has(words[at]); at += 1) {
    const word = words[at];
    if (isNumber(word)) phrase.count = Number(word);
    else if (COUNT_WORDS.has(word)) phrase.count = COUNT_WORDS.get(word);
    else if (ORDINAL_WORDS.has(word)) {
      phrase.numbers.push(ORDINAL_WORDS.get(word));
      // The noun then comes right after the last ordinal.
      const next = nextOrdinal(words, at + 1, and);
      if (next) {
        at = next - 1;
        limit = next + 1;
      }
    } else if (UNCLEAR_WORDS.has(word)) phrase.unclear = true;
    else if (!PLAIN_DETERMINERS.has(word) && !ONLY_WORDS.has(word)) return null;
  }
  const kind = MEDIA_FORMS.get(words[at]);
  if (!kind) return null;
  at += 1;
  while (isNumber(words[at])) {
    phrase.numbers.push(Number(words[at]));
    at += 1;
    if (and.has(words[at]) && isNumber(words[at + 1])) at += 1;
  }
  return { ...phrase, kind, end: at };
}

// Media noun phrases one after another, joined by "and" or a comma
// ("картинката и видеото", "картинка 1 и видеото", "картинка 1, картинка 2 и
// видеото"): the phrases, the kinds they name and the index after them; null
// when there is none at `start`. "both" pairs two or more phrases ("both the
// picture and the video"); before a single one it is a count ("both
// pictures", review r5: under three pictures that names two, so it is no
// offer).
function nounPhrases(words, start, and = AND_WORDS) {
  if (words[start] === "both") {
    const paired = readPhrases(words, start + 1, and);
    if (paired?.phrases.length > 1) return paired;
  }
  return readPhrases(words, start, and);
}

function readPhrases(words, start, and) {
  const phrases = [];
  let at = start;
  while (phrases.length < MAX_NOUN_PHRASES) {
    const phrase = nounAt(words, at, and) || (phrases.length && and.has(words[at]) ? nounAt(words, at + 1, and) : null);
    if (!phrase) break;
    phrases.push(phrase);
    at = phrase.end;
  }
  if (!phrases.length) return null;
  return { phrases, kinds: KINDS.filter((kind) => phrases.some((phrase) => phrase.kind === kind)), end: at };
}

// Every item of every kind: what a pronoun ("ще ги направя") names.
const EVERY_ITEM = KINDS.map((kind) => ({ kind, count: 0, numbers: [], unclear: false }));

// The words that may count a pronoun's items ("ще ги направя всичките",
// "правя ги и двете", "make them both", "make all of them"), with how many
// items they count (0: every item, whatever their number).
const PRONOUN_COUNTS = new Map([
  ...["всички", "всичките", "all", "alle", "todas", "todos", "toutes", "tous", "tutte", "tutti", "toate"].map((word) => [word, 0]),
  ...["двете", "двата", "both", "beide", "ambas", "ambos", "entrambe", "entrambi", "amândouă"].map((word) => [word, 2]),
  ...[["трите", 3], ["четирите", 4]],
]);

// A pronoun object at `at`: "them", "all of them", "both of them". Returns
// the index after it and how many items it counts (PRONOUN_COUNTS), or null.
function pronounAt(words, at) {
  if (OBJECT_PRONOUNS.has(words[at])) return { end: at + 1, total: 0 };
  if (PRONOUN_COUNTS.has(words[at]) && words[at + 1] === "of" && OBJECT_PRONOUNS.has(words[at + 2])) {
    return { end: at + 3, total: PRONOUN_COUNTS.get(words[at]) };
  }
  return null;
}

// The count word that may follow a pronoun („всичките“, „и двете“, "all",
// "both"): the index after it and its count, or the same index and 0.
function pronounCountAt(words, at, and) {
  const skip = and.has(words[at]) && PRONOUN_COUNTS.get(words[at + 1]) ? 1 : 0;
  const word = words[at + skip];
  return PRONOUN_COUNTS.has(word) ? { end: at + skip + 1, total: PRONOUN_COUNTS.get(word) } : { end: at, total: 0 };
}

// Every item, or every item when the pronoun's count says how many there are
// (`total`, checked by offeredItems: "make them both" under three is
// unclear).
const everyItem = (total) => (total ? Object.assign([...EVERY_ITEM], { total }) : EVERY_ITEM);

// Words that say a verb is not done ("няма да правя видеото", "I won't make
// the video"), and those that may stand between them and the verb.
const NEGATIONS = new Set([
  "не", "няма", "никога", "not", "never", "won", "don", "didn", "nicht", "nie", "kein", "keine", "no",
  "nunca", "ne", "pas", "jamais", "non", "mai", "nu",
]);
const BEFORE_VERB = new Set([
  "ще", "да", "ги", "го", "я", "ли", "will", "ll", "t", "to", "voi",
  // The clitics of „no las hago“, „je ne les fais pas“, „non le faccio“, „nu le voi face“.
  "le", "les", "la", "lo", "las", "los", "li", "l", "o", "îl",
]);

// Whether the make verb at `verb` is said not to be done.
function negated(words, verb) {
  let at = verb - 1;
  while (at >= 0 && at > verb - 4 && BEFORE_VERB.has(words[at])) at -= 1;
  return NEGATIONS.has(words[at]);
}

// The kinds a make verb's object names: the media nouns after it ("правя
// картинките", "Да направя ли картинките?"), or every kind for a pronoun
// after it ("make all of them") or a clitic right before it ("ще ги
// направя", "le voi face"); null when its object is not the media, or the
// verb is not done ("няма да правя видеото").
function objectKinds(words, verb) {
  if (negated(words, verb)) return null;
  const before = words[verb - 1] === "voi" ? verb - 2 : verb - 1;
  if (OBJECT_PRONOUNS.has(words[before])) return KINDS;
  const start = words[verb + 1] === "ли" ? verb + 2 : verb + 1;
  const noun = nounPhrases(words, start);
  if (noun) return noun.kinds;
  return pronounAt(words, start) ? KINDS : null;
}

// The kinds of media the step offers to make (the card's condition): a make
// verb whose object is the media, followed within two determiners or numbers
// by a media noun or an object pronoun, or with a clitic pronoun right before
// it. null when the step has no such verb: "гледай първото видео", "качи
// видеото", "направя анализ на видеото", "optimise the images" and "няма да
// правя видеото" have none.
export function makeKinds(step) {
  const words = stepWords(step);
  const kinds = new Set();
  let found = false;
  words.forEach((word, index) => {
    if (!isMakeVerb(words, index)) return;
    const named = objectKinds(words, index);
    if (!named) return;
    found = true;
    named.forEach((kind) => kinds.add(kind));
  });
  return found ? KINDS.filter((kind) => kinds.has(kind)) : null;
}

// Whether the step offers to make the pictures or video at all.
export function makeIntent(step) {
  return makeKinds(step) !== null;
}

// The rule's own Next line and its close variants in each page language:
// "[lead words] <say> [with] yes and [I] [will] [them] <make> [<object>]
// [now]", or "<say> yes to <make> …" ("type yes to make the picture",
// „напиши „да“, за да ги направя“). `with` is the word of „отговори с „да““
// and "reply with yes"; `infinitive` the verbs read only after `will`
// (Romanian „voi face“).
const OFFER_LANGUAGES = [
  {
    ask: ["напиши", "кажи", "отговори"],
    with: ["с", "със"],
    yes: ["да"],
    and: ["и"],
    to: [["за", "да"]],
    subject: [],
    will: ["ще"],
    make: ["правя", "направя", "нарисувам", "рисувам", "създам", "създавам", "генерирам"],
    now: ["сега", "веднага"],
  },
  {
    ask: ["say", "type", "write", "reply"],
    with: ["with"],
    yes: ["yes"],
    and: ["and"],
    to: [["to"]],
    subject: ["i"],
    will: ["ll", "will"],
    make: ["make", "create", "draw", "generate"],
    now: ["now"],
  },
  {
    ask: ["sag", "sage", "schreib", "schreibe", "antworte"],
    with: ["mit"],
    yes: ["ja"],
    and: ["und"],
    subject: ["ich"],
    will: [],
    make: ["erstelle", "mache", "zeichne", "generiere"],
    now: ["jetzt"],
  },
  {
    ask: ["di", "dime", "escribe", "responde"],
    with: ["con"],
    yes: ["sí", "si"],
    and: ["y"],
    subject: ["yo"],
    will: [],
    make: ["hago", "creo", "genero", "dibujo", "haré", "crearé", "generaré", "dibujaré"],
    now: ["ahora"],
  },
  {
    ask: ["dis", "écris", "réponds", "tape"],
    with: ["par", "avec"],
    yes: ["oui"],
    and: ["et"],
    subject: ["je", "j"],
    will: [],
    make: ["fais", "crée", "génère", "dessine", "ferai", "créerai", "générerai", "dessinerai"],
    now: ["maintenant"],
  },
  {
    ask: ["di", "dì", "scrivi", "rispondi"],
    with: ["con"],
    yes: ["sì", "si"],
    and: ["e"],
    subject: ["io"],
    will: [],
    make: ["faccio", "creo", "genero", "disegno", "farò", "creerò", "genererò", "disegnerò"],
    now: ["ora", "adesso"],
  },
  {
    ask: ["spune", "scrie", "răspunde"],
    with: ["cu"],
    yes: ["da"],
    and: ["și", "si"],
    subject: ["eu"],
    will: ["voi"],
    make: ["fac", "creez", "generez", "desenez"],
    infinitive: [...AFTER_VOI],
    now: ["acum"],
  },
].map((language) => ({ to: [], infinitive: [], ...language, andSet: new Set(language.and) }));

// How far into the step its ask word may stand: the words before it lead in
// („Ако искаш, напиши „да“ и…“, "Just say yes and…", review r5). Only the
// strict tail after the ask word makes the step an offer.
const MAX_LEAD_WORDS = 8;

// Reads the step from `from` (its ask word) as one language's offer, word by
// word, and returns the noun phrases its object names (nounAt), or null. The
// object is a pronoun (every item of every kind, or as many as its count
// says: „ги правя и двете“), or media nouns with their determiners, counts,
// ordinals and numbers, joined by "and" or a comma; after it only "now" may
// follow.
function readsAsOffer(words, language, from) {
  let at = from;
  const take = (list) => {
    if (!list.includes(words[at])) return false;
    at += 1;
    return true;
  };
  if (!take(language.ask)) return null;
  take(language.with);
  if (!take(language.yes)) return null;
  const link = language.to.find((sequence) => sequence.every((word, offset) => words[at + offset] === word));
  let will = false;
  if (link) {
    at += link.length;
  } else {
    if (!take(language.and)) return null;
    take(language.subject);
    will = take(language.will);
  }
  const clitic = OBJECT_PRONOUNS.has(words[at]);
  if (clitic) at += 1;
  // „и le voi face“: the clitic comes before the future's „voi“.
  if (clitic && !will && !link) will = take(language.will);
  if (!take(language.make) && !(will && take(language.infinitive))) return null;
  let phrases;
  const noun = nounPhrases(words, at, language.andSet);
  const pronoun = noun ? null : pronounAt(words, at);
  if (noun) {
    phrases = noun.phrases;
    at = noun.end;
  } else if (pronoun || clitic) {
    let total = pronoun?.total || 0;
    if (pronoun) at = pronoun.end;
    if (!total) {
      const counted = pronounCountAt(words, at, language.andSet);
      at = counted.end;
      total = counted.total;
    }
    phrases = everyItem(total);
  } else {
    return null;
  }
  take(language.now);
  return at === words.length ? phrases : null;
}

// The noun phrases of an offer (readsAsOffer), or null when the step is no
// offer: a question, or any other word after the object ("по-ярки",
// "vertical", "за рекламата"), makes it none.
function offerPhrases(step) {
  if (typeof step !== "string" || ASKS_BACK.test(step)) return null;
  const words = stepWords(step);
  for (let from = 0; from <= MAX_LEAD_WORDS && from < words.length; from += 1) {
    for (const language of OFFER_LANGUAGES) {
      if (!language.ask.includes(words[from])) continue;
      const phrases = readsAsOffer(words, language, from);
      if (phrases) return phrases;
    }
  }
  return null;
}

// Whether the step reads as an offer that a short yes may answer: the rule's
// own line or a close variant ("напиши „да“ и правя картинките и видеото.",
// "Sag „ja“ und ich erstelle das Bild.", "напиши „да“ и правя картинка 1 и
// видеото."). Which of the described items it starts is mediaOffer's
// `offered`.
export function isMediaOffer(step) {
  return offerPhrases(step) !== null;
}

// A short plain paragraph may follow an offer ("Ако искаш друг стил, кажи.",
// "(Картинката струва 2 единици.)"): at most this many characters.
const TRAILING_TEXT_LIMIT = 200;

// The step an answer with descriptions offers: its own Next step, or else its
// last Next line outside code when only one short plain paragraph follows
// it, with no label, no Next line, no code and no question. "" otherwise.
export function mediaNextStep(text) {
  const own = ownNextStep(text);
  if (own) return own;
  const lines = String(text || "").trimEnd().slice(-READ_LIMIT).split("\n");
  const blocks = codeBlocksOfLines(lines);
  let index = lines.length - 1;
  while (index >= 0 && (blocks[index] || !isNextStepLine(lines[index]))) index -= 1;
  if (index < 0) return "";
  const after = lines.slice(index + 1);
  const first = after.findIndex((line) => line.trim());
  const paragraph = first < 0 ? [] : after.slice(first);
  const rest = paragraph.join("\n").trim();
  if (
    !rest ||
    rest.length > TRAILING_TEXT_LIMIT ||
    ASKS_BACK.test(rest) ||
    paragraph.some(
      (line, at) =>
        !line.trim() ||
        blocks[index + 1 + first + at] ||
        readMediaLabel(line) ||
        scriptLabel(line) ||
        isNextStepLine(line),
    )
  ) {
    return "";
  }
  return nextLineStep(lines[index]);
}

const noneMissing = () => ({ unavailable: { image: 0, video: 0 }, extra: { image: 0, video: 0 } });

// The described item a number names ("картинка 2", "втората картинка"): the
// one whose label has that number, or else the one at that place among the
// described of its kind when that one has no number of its own.
function numberedItem(ofKind, number) {
  const labelled = ofKind.find((item) => item.number === number);
  if (labelled) return labelled;
  const placed = ofKind[number - 1];
  return placed && !placed.number ? placed : null;
}

// The items an offer's object names (review r2): of `named` (the described
// items of the step's kinds, in order) those `kept` (that this account can
// make within the limits). A media noun alone names every item of its kind
// („картинките“, „картинката и видеото“); numbers and ordinals name those
// items („картинка 1 и видеото“, „първата картинка“); a count names every
// item of its kind when it is how many were described („двете картинки“,
// „a picture“ under one picture). Returns { items, missing } (what it names
// that will not be made), or null when it is unclear which items are meant:
// an unclear word („последната“), a number that names no described item, or
// a count that is not how many were described („една картинка“ under four,
// „ги правя и двете“ under three).
function offeredItems(phrases, named, kept) {
  if (!phrases) return null;
  // A pronoun's count („ги правя и двете“) is how many were described, or it
  // is unclear which it means.
  if (phrases.total && phrases.total !== named.length) return null;
  const chosen = new Set();
  const missing = noneMissing();
  const add = (item) => {
    if (chosen.has(item)) return;
    chosen.add(item);
    if (kept.has(item)) return;
    missing[kept.unavailable.has(item.kind) ? "unavailable" : "extra"][item.kind] += 1;
  };
  for (const phrase of phrases) {
    if (phrase.unclear) return null;
    const ofKind = named.filter((item) => item.kind === phrase.kind);
    if (phrase.numbers.length) {
      for (const number of phrase.numbers) {
        const item = numberedItem(ofKind, number);
        if (!item) return null;
        add(item);
      }
      continue;
    }
    if (phrase.count && phrase.count !== ofKind.length) return null;
    ofKind.forEach(add);
  }
  return { items: named.filter((item) => chosen.has(item) && kept.has(item)), missing };
}

// What the previous answer offers this account (3.3 of the design). `kinds`
// are the kinds its step offers to make (null without make intent); `items`
// the descriptions of those kinds it can make (at most four pictures and one
// video; every kind when the step offers none, for the notes), one per
// description; `card` whether they get a card; `offer` whether a short yes
// starts some of them, and `offered` which („правя картинка 1 и видеото“
// starts those two); `missing` what of those kinds was described but will
// not be made ({ unavailable, extra }, counted per kind), and
// `offeredMissing` the same of what the offer names; `described` how many
// of those kinds were described; `script` the script column that made them
// none ("Звук"). Descriptions of a kind the step does not offer (a readout's
// "Видео:" line, a video "for later" under an offer of pictures) get no
// button.
export function mediaOffer(answer, available = {}) {
  const { items: described, labelled, script } = readDescriptions(answer);
  const step = labelled ? mediaNextStep(answer) : ownNextStep(answer);
  const kinds = makeKinds(step);
  // The same description twice is one item: the page makes it once.
  const keys = new Set();
  const named = (kinds ? described.filter((item) => kinds.includes(item.kind)) : described).filter((item) => {
    const key = mediaKey(item);
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  });
  const allowed = { image: Boolean(available?.images), video: Boolean(available?.video) };
  const counts = { image: 0, video: 0 };
  const missing = noneMissing();
  const items = [];
  for (const item of named) {
    if (!allowed[item.kind]) missing.unavailable[item.kind] += 1;
    else if (counts[item.kind] >= MAX_ITEMS[item.kind]) missing.extra[item.kind] += 1;
    else {
      counts[item.kind] += 1;
      items.push(item);
    }
  }
  const card = items.length > 0 && kinds !== null;
  const kept = Object.assign(new Set(items), { unavailable: new Set(KINDS.filter((kind) => !allowed[kind])) });
  const offered = card ? offeredItems(offerPhrases(step), named, kept) : null;
  return {
    items,
    card,
    offer: Boolean(offered?.items.length),
    offered: offered?.items || [],
    offeredMissing: offered?.missing || noneMissing(),
    missing,
    step,
    described: named.length,
    kinds,
    script,
  };
}

// What the page needs in the done event: the items, with what each costs this
// account (the owner is not charged; the routes reserve the same amounts) and
// the answer's own number for the button.
export function chatMediaEvent(items, { start = false, member = false } = {}) {
  if (!Array.isArray(items) || !items.length) return null;
  return {
    start: Boolean(start),
    items: items.map(({ kind, prompt, number }) => ({
      kind,
      prompt,
      units: member ? CREDITS[kind] : 0,
      ...(number ? { number } : {}),
    })),
  };
}

// One item, as the page tells its items apart ("kind:description").
export const mediaKey = ({ kind, prompt }) => `${kind}:${prompt}`;

// The card the page shows under the answer a short yes replies to: the keys
// of its items that are queued, being made or made. Anything that is not an
// array of at most 10 strings of at most 2,100 characters is ignored (null).
export function parseMediaCard(value) {
  const made = value && typeof value === "object" ? value.made : undefined;
  if (!Array.isArray(made) || made.length > 10) return null;
  if (!made.every((key) => typeof key === "string" && key.length <= 2_100)) return null;
  return new Set(made);
}

// ── The person's yes ───────────────────────────────────────────────────────

// Words a yes may name the media with besides its agreeing words and plain
// determiners: "and", "only" ("направи само картинките").
const YES_MEDIA_WORDS = new Set([...AND_WORDS, ...ONLY_WORDS]);
const MAX_MEDIA_YES_WORDS = 8;
// The verbs of making that agree only in a yes to pictures or video, never to
// another step („Нарисувай ги“ after a mail step is no yes, review r5), with
// the kind each names when no media noun does: drawing is pictures,
// generating or creating is every kind.
const MEDIA_YES_VERBS = new Map([
  ...["нарисувай", "нарисувайте", "narisuvai", "narisuvay", "draw", "zeichne"].map((word) => [word, "image"]),
  ...["генерирай", "генерирайте", "създай", "създайте", "generirai", "generiray", "generate", "generiere"].map(
    (word) => [word, ""],
  ),
]);
// How many items a word in a yes counts („двете“, „both“, „една картинка“).
// The Romanian "o" is left out: in „fă-o“ it is "it".
const YES_COUNT_WORDS = new Map([...COUNT_WORDS].filter(([word]) => word !== "o"));
// Words that ask for something the answer did not describe („нова“, „още
// една“, „пак“, "another", "again"): such a message is a new request for the
// model, never a yes that starts the described items (review r2).
const NEW_WORDS = new Set([
  "нова", "нови", "новата", "новите", "ново", "новото", "нов", "новия", "още", "пак", "отново",
  "друга", "други", "друго", "друг", "другата", "другите", "другото", "другия",
  "nova", "novi", "novo", "oshte", "pak", "otnovo", "druga", "drugi",
  "new", "another", "more", "other", "others", "again", "else",
  "neue", "neuen", "neues", "neuer", "noch", "andere", "anderes", "wieder",
  "nuevo", "nueva", "nuevos", "nuevas", "otra", "otro", "otras", "otros", "más", "mas", "otravez",
  "nouveau", "nouvelle", "nouveaux", "nouvelles", "autre", "autres", "encore",
  "nuovo", "nuova", "nuovi", "nuove", "altra", "altro", "altre", "altri", "ancora",
  "nou", "nouă", "noua", "noi", "alta", "alt", "altă", "încă", "inca",
]);

// A short yes, also one that names what to make: „да“, „ДА ДАВАЙ“, „Давай,
// направи ги всичките“, „НАПРАВИ КАРТИНКИТЕ“, „направи картинката и
// видеото“, „направи двете картинки“, „направи 2-те“, „Нарисувай ги“, „make
// them“. Returns the kinds it names (empty when it names none) and how many
// items it counts per kind ("" for a count with no media noun after it,
// „направи двете“; one picture or video named in the singular counts one),
// and `too` for a yes that adds one kind with "and" („Да, и видеото“, "Yes,
// and the video": everything offered, see mediaYesAnswer); or null when the
// message is not such a yes: „направи картинките по-ярки“, „ok thanks“, and
// one that picks items by number or place or asks for new ones („Да, само
// първата“, „Направи 1“, „Направи 2-та“, „Направи нова картинка“, review
// r2), which the model answers.
function readMediaYes(message) {
  const words = shortMessageWords(message);
  if (!words?.length || words.length > MAX_MEDIA_YES_WORDS) return null;
  const kinds = new Set();
  const counts = new Map();
  const addCount = (kind, number) => counts.set(kind, (counts.get(kind) || 0) + number);
  const agreeing = [];
  // Where the first word that agrees stands, and the kind a verb names.
  let firstYes = -1;
  let drawn = null;
  let pending = 0;
  let nouns = 0;
  let too = "";
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    // „2-те“ counts; „2-та“ and „2-ра“ pick by place.
    if (isNumber(word) && words[index + 1] === "те" && Number(word) >= 2 && Number(word) <= MAX_CHAT_IMAGES) {
      if (pending) addCount("", pending);
      pending = Number(word);
      index += 1;
      continue;
    }
    if (isNumber(word) || ORDINAL_WORDS.has(word) || UNCLEAR_WORDS.has(word) || NEW_WORDS.has(word)) return null;
    const kind = MEDIA_FORMS.get(word);
    if (kind) {
      nouns += 1;
      // „Да, и видеото“: "and" before the noun (past its determiners), after a
      // word that agrees, never the agreeing word itself („Si, imágenes“).
      let back = index - 1;
      while (back > firstYes && PLAIN_DETERMINERS.has(words[back])) back -= 1;
      if (firstYes >= 0 && back > firstYes && AND_WORDS.has(words[back])) too = kind;
      kinds.add(kind);
      const number = pending || (SINGLE_MEDIA.has(word) ? 1 : 0);
      if (number) addCount(kind, number);
      pending = 0;
    } else if (YES_COUNT_WORDS.has(word)) {
      if (pending) addCount("", pending);
      pending = YES_COUNT_WORDS.get(word);
    } else if (MEDIA_YES_VERBS.has(word)) {
      if (firstYes < 0) firstYes = index;
      if (drawn === null || MEDIA_YES_VERBS.get(word) === "") drawn = MEDIA_YES_VERBS.get(word);
      agreeing.push("направи");
    } else if (isYesWord(word)) {
      if (firstYes < 0 && word !== "и") firstYes = index;
      agreeing.push(word);
    } else if (!PLAIN_DETERMINERS.has(word) && !YES_MEDIA_WORDS.has(word)) {
      return null;
    }
  }
  if (pending) addCount("", pending);
  if (!isBareAgreement(agreeing)) return null;
  // A verb of making names its kinds when no noun names one: „Нарисувай ги“
  // the pictures, „Генерирай ги“ every kind. Never no kind, which would agree
  // to any step (buildProposedStepNote).
  if (!kinds.size && drawn !== null) (drawn ? [drawn] : KINDS).forEach((kind) => kinds.add(kind));
  return nouns === 1 && too ? { kinds, counts, too } : { kinds, counts };
}

// The kinds a short yes names (see readMediaYes), or null when the message
// is no such yes.
export function mediaYesKinds(message) {
  return readMediaYes(message)?.kinds ?? null;
}

// Whether the counts of a yes are how many items the offer names: „направи
// двете картинки“ under two offered pictures, „направи картинката“ under
// one. A count with no media noun is compared with every item of the kinds
// the yes names, or of all kinds.
function countsMatch(yes, offer) {
  const offeredOf = (kind) =>
    count(offer.offered, kind) + (offer.offeredMissing.unavailable[kind] || 0) + (offer.offeredMissing.extra[kind] || 0);
  for (const [kind, number] of yes.counts) {
    const kinds = kind ? [kind] : yes.kinds.size ? [...yes.kinds] : KINDS;
    if (kinds.reduce((sum, each) => sum + offeredOf(each), 0) !== number) return false;
  }
  return true;
}

// ── The page's own lines and the answer a yes replies to ──────────────────

// The lines the page itself adds to its history when it makes a picture or a
// clip (daily-plan.js): the person's "🎨 <description>" or "🎬 <description>"
// and, once made, "🎨 Нарисувах картинка: …" or "🎬 Направих видео: …" (on
// other page languages, their own words). The page marks each with `page:
// true` (review r2: a typed message or an answer that starts with "🎬 " is
// the person's or the model's, not the page's), and each is one line of at
// most 400 characters. The server never saves them, so a saved turn is never
// one.
export function isPageMediaLine(message) {
  if (message?.page !== true || (message.role !== "user" && message.role !== "assistant")) return false;
  const text = typeof message.content === "string" ? message.content.trim() : "";
  return (
    text.length <= 400 &&
    (text.startsWith("🎨 ") || text.startsWith("🎬 ")) &&
    !text.includes("\n")
  );
}

// The whole text turns, newest last, at most the last 48: the page sends its
// last 12 turns and at most 24 of its own picture and clip lines among them.
function textTurns(value) {
  return (Array.isArray(value) ? value.slice(-48) : []).filter(
    (item) =>
      (item?.role === "user" || item?.role === "assistant") &&
      typeof item.content === "string" &&
      item.content.trim(),
  );
}

// The turns a short yes is read against, whole (the history the model gets
// has its Next lines stripped): the page's own, or the saved ones followed
// by the page's when the page's turns hold no answer to read (a new tab, a
// client that sends no history, or only the page's picture lines and the
// server's replies to a yes). Retry and edit use only the page's turns, as
// the history does.
export function shortYesTurns(saved, recent, { rewrite = false } = {}) {
  const page = textTurns(recent);
  if (rewrite || previousExchange(page).answer) return page;
  return [...textTurns(saved), ...page];
}

// The answer a short yes replies to: the last turn, past the page's own
// picture and clip lines and past the server's own replies to a yes (with
// the yes before each), when it is an answer; and the request before it. So
// a second „да“ after „Правя картинката…“ or „Натисни бутоните…“ answers the
// offer above them. Only that answer counts.
export function previousExchange(turns = []) {
  const list = textTurns(turns);
  const skipLines = (from) => {
    let at = from;
    while (at >= 0 && isPageMediaLine(list[at])) at -= 1;
    return at;
  };
  let index = skipLines(list.length - 1);
  while (list[index]?.role === "assistant" && isMediaYesReply(list[index].content)) {
    const yes = skipLines(index - 1);
    if (list[yes]?.role !== "user" || mediaYesKinds(list[yes].content) === null) break;
    index = skipLines(yes - 1);
  }
  if (list[index]?.role !== "assistant") return { request: "", answer: "" };
  const request = list
    .slice(0, index)
    .findLast((turn) => turn.role === "user" && !isPageMediaLine(turn));
  return { request: request?.content.trim() || "", answer: list[index].content };
}

// ── What the person and the model are told ─────────────────────────────────

const count = (items, kind) => items.filter((item) => item.kind === kind).length;

const REPLY_WORDS = {
  bg: {
    what: (images, video) =>
      [images === 1 ? "картинката" : images > 1 ? `${images} картинки` : "", video ? "видеото" : ""]
        .filter(Boolean)
        .join(" и "),
    making: (what) => `Правя ${what}.`,
    howLong: (images, video) =>
      images && video
        ? "Картинка отнема до половин минута, видеото — от една до четири минути."
        : video
          ? "Отнема от една до четири минути."
          : images === 1
            ? "Отнема до половин минута."
            : "Всяка отнема до половин минута.",
    total: (units) => ` Струва ${units} единици.`,
    already: (images, video) =>
      images + video > 1
        ? "Те вече се правят или са готови."
        : video
          ? "Видеото вече се прави или е готово."
          : "Картинката вече се прави или е готова.",
    press: (images, video) =>
      images + video > 1
        ? "Описанията са в предишния отговор. Натисни бутоните отдолу, за да ги направя."
        : `Описанието е в предишния отговор. Натисни бутона отдолу, за да ${video ? "го" : "я"} направя.`,
    price: (images, video) =>
      images && video
        ? ` Картинка струва ${PUBLIC_IMAGE_CREDITS} единици, видео — ${PUBLIC_VIDEO_CREDITS} единици.`
        : video
          ? ` Видео струва ${PUBLIC_VIDEO_CREDITS} единици.`
          : ` Картинка струва ${PUBLIC_IMAGE_CREDITS} единици.`,
    unavailable: { image: ["Картинката не може", "Картинките не могат"], video: ["Видеото не може", "Видеата не могат"] },
    unavailableEnd: (one) => (one ? " да се направи тук в момента." : " да се направят тук в момента."),
    extra: { image: `Правя само първите ${MAX_CHAT_IMAGES} картинки.`, video: "Правя само първото видео." },
  },
  en: {
    what: (images, video) =>
      [images === 1 ? "the picture" : images > 1 ? `${images} pictures` : "", video ? "the video" : ""]
        .filter(Boolean)
        .join(" and "),
    making: (what) => `I'm making ${what}.`,
    howLong: (images, video) =>
      images && video
        ? "A picture takes up to half a minute, the video one to four minutes."
        : video
          ? "It takes one to four minutes."
          : images === 1
            ? "It takes up to half a minute."
            : "Each takes up to half a minute.",
    total: (units) => ` It costs ${units} units.`,
    already: (images, video) =>
      images + video > 1
        ? "They are already being made or are ready."
        : video
          ? "The video is already being made or is ready."
          : "The picture is already being made or is ready.",
    press: (images, video) =>
      images + video > 1
        ? "The descriptions are in the previous answer. Press the buttons below to make them."
        : "The description is in the previous answer. Press the button below to make it.",
    price: (images, video) =>
      images && video
        ? ` A picture costs ${PUBLIC_IMAGE_CREDITS} units, a video ${PUBLIC_VIDEO_CREDITS} units.`
        : video
          ? ` A video costs ${PUBLIC_VIDEO_CREDITS} units.`
          : ` A picture costs ${PUBLIC_IMAGE_CREDITS} units.`,
    unavailable: { image: ["The picture can't", "The pictures can't"], video: ["The video can't", "The videos can't"] },
    unavailableEnd: () => " be made here right now.",
    extra: { image: `I'll make only the first ${MAX_CHAT_IMAGES} pictures.`, video: "I'll make only the first video." },
  },
};

// How the server's own replies to a yes begin (mediaYesReply), in both
// languages and for every count: a turn that is one of them is passed over
// when the next yes looks for the answer it replies to.
const MEDIA_YES_OPENINGS = Object.values(REPLY_WORDS).flatMap((words) =>
  Array.from({ length: (MAX_CHAT_IMAGES + 1) * 2 }, (_, at) => [at >> 1, at & 1])
    .filter(([images, video]) => images + video > 0)
    .flatMap(([images, video]) => [
      words.making(words.what(images, video)),
      words.press(images, video),
      words.already(images, video),
    ]),
);

// Whether an answer is the server's own reply to a yes: one line that starts
// with one of those openings.
export function isMediaYesReply(text) {
  const value = typeof text === "string" ? text.trim() : "";
  return (
    value.length <= 600 &&
    !value.includes("\n") &&
    MEDIA_YES_OPENINGS.some((opening) => value === opening || value.startsWith(`${opening} `))
  );
}

// Only the kinds in `kinds` of what was described but will not be made.
const missingOf = (missing, kinds) => ({
  unavailable: Object.fromEntries(KINDS.map((kind) => [kind, kinds.has(kind) ? missing?.unavailable?.[kind] || 0 : 0])),
  extra: Object.fromEntries(KINDS.map((kind) => [kind, kinds.has(kind) ? missing?.extra?.[kind] || 0 : 0])),
});

// What was described but will not be made, as sentences that each start with
// a space ("" when nothing is missing): a kind this account cannot make now,
// or descriptions over the limits. Words of the reply to a yes, in its first
// person ("Правя само първото видео.").
export function missingMediaText(missing, { english = false } = {}) {
  const words = REPLY_WORDS[english ? "en" : "bg"];
  const sentences = [];
  for (const kind of KINDS) {
    const unavailable = missing?.unavailable?.[kind] || 0;
    if (unavailable) {
      sentences.push(`${words.unavailable[kind][unavailable === 1 ? 0 : 1]}${words.unavailableEnd(unavailable === 1)}`);
    }
    if (missing?.extra?.[kind]) sentences.push(words.extra[kind]);
  }
  return sentences.map((sentence) => ` ${sentence}`).join("");
}

// The same for the note to the model, which makes nothing: plain facts, never
// "Правя…", which the model would repeat to the person.
function missingNoteText(missing) {
  return [
    missing?.unavailable?.image ? "Картинки не могат да се направят тук в момента." : "",
    missing?.extra?.image ? `Бутони има само за първите ${MAX_CHAT_IMAGES} картинки.` : "",
    missing?.unavailable?.video ? "Видео не може да се направи тук в момента." : "",
    missing?.extra?.video ? "Бутон има само за първото видео." : "",
  ]
    .filter(Boolean)
    .join(" ");
}

// The reply to a short yes to an offer, made without the model (4.1 of the
// design). `made` holds the keys the page's card has queued, running or made,
// or is null when the page shows no card for that answer: then nothing
// starts, and the card comes under this reply with every item of the
// answer's card (of the kinds the yes names) and the price on its buttons.
// What starts is what the offer names (`offered`: „правя картинка 1 и
// видеото“ starts those two). `kinds` are the kinds the yes names („направи
// видеото“): only those are made; null when it names none. Returns null when
// the offer names nothing of those kinds.
export function mediaYesReply(offer, { made = null, member = false, english = false, kinds = null } = {}) {
  const words = REPLY_WORDS[english ? "en" : "bg"];
  const named = kinds?.size ? kinds : null;
  const ofNamed = (items) => (named ? items.filter((item) => named.has(item.kind)) : items);
  const chosen = ofNamed(offer.offered || []);
  if (!chosen.length) return null;
  if (!made) {
    const all = ofNamed(offer.items);
    const missing = missingMediaText(named ? missingOf(offer.missing, named) : offer.missing, { english });
    return {
      text: `${words.press(count(all, "image"), count(all, "video"))}${
        member ? words.price(count(all, "image"), count(all, "video")) : ""
      }${missing}`,
      media: chatMediaEvent(all, { start: false, member }),
    };
  }
  const missing = missingMediaText(named ? missingOf(offer.offeredMissing, named) : offer.offeredMissing, {
    english,
  });
  const start = chosen.filter((item) => !made.has(mediaKey(item)));
  if (!start.length) {
    return { text: words.already(count(chosen, "image"), count(chosen, "video")), media: null };
  }
  const images = count(start, "image");
  const video = count(start, "video");
  const units = start.reduce((sum, item) => sum + CREDITS[item.kind], 0);
  return {
    text: `${words.making(words.what(images, video))} ${words.howLong(images, video)}${
      member ? words.total(units) : ""
    }${missing}`,
    media: chatMediaEvent(start, { start: true, member }),
  };
}

// The server's answer to a yes that starts the previous answer's pictures and
// video (4.1 of the design), for the chat route and the robot's stub alike:
// null when the message is no such yes, the previous answer offers none, the
// yes names a kind the offer does not have, or it counts a different number
// of items than the offer names („направи една картинка“ under four).
export function mediaYesAnswer(message, turns, { mediaCard, available, member = false, english = false } = {}) {
  const yes = readMediaYes(message);
  if (!yes) return null;
  const offer = mediaOffer(previousExchange(turns).answer, available);
  if (!offer.offer || !countsMatch(yes, offer)) return null;
  const made = parseMediaCard(mediaCard);
  // „Да, и видеото“: every offered item not made yet, but only while the kind
  // it adds still has one to make (review r5: after both pictures were
  // pressed, „Давай, и картинките“ must not start the video); otherwise, and
  // when that kind is not offered, the yes names that kind alone.
  const tooLeft = Boolean(yes.too) && offer.offered.some((item) => item.kind === yes.too && !made?.has(mediaKey(item)));
  return mediaYesReply(offer, { made, member, english, kinds: tooLeft ? null : yes.kinds });
}

// Whether a text speaks of pictures or video at all.
const mentionsMedia = (text) => stepWords(text).some((word) => MEDIA_FORMS.has(word));

// What the note before a yes says about the previous answer's pictures and
// video when the yes does not start them (4.2 of the design), in the note's
// Bulgarian: nothing is made by this message, and how they are made. With a
// card they are made by its buttons. Without one (its step only asks about
// them, "кажи дали видеото да е вертикално"), and only when the step or the
// message speaks of pictures or video, the model writes them again. A script
// column, or descriptions not in the format, are named as the reason.
export function mediaNoteLines(offer, { english = false, message = "" } = {}) {
  if (!offer) return [];
  const line = english ? "`Next: say yes and I will make …`" : "`Следва: напиши „да“ и правя …`";
  if (offer.items.length) {
    if (offer.card) {
      return [
        `Този отговор не прави картинки или видео: те се правят само с бутоните под предишния ти отговор или с кратко „да“ веднага след отговор, чийто последен ред е ${line}. Не казвай, че се правят или че са готови.`,
        missingNoteText(offer.missing),
      ].filter(Boolean);
    }
    if (!mentionsMedia(offer.step) && !mentionsMedia(message)) return [];
    return [
      `Ако човекът иска картинки или видео: този отговор не ги прави, а под предишния ти отговор няма бутони за тях, защото стъпката му не предлага да ги направиш. Напиши описанията отново и завърши с реда ${line} Не казвай, че се правят или че са готови.`,
    ];
  }
  if (offer.script && offer.kinds) {
    const labels = english ? "`Image 1: …` или `Video: …`" : "`Картинка 1: …` или `Видео: …`";
    return [
      `Нищо не се прави: редът „${offer.script}:“ прави предишния ти отговор сценарий, а не описания за правене. Ако човекът ги иска, напиши всяко описание отново на един ред ${labels}, като звукът, музиката и текстът на екрана са в същия ред, без отделен ред „${offer.script}:“, и завърши с реда ${line}`,
    ];
  }
  if (isMediaOffer(offer.step)) {
    if (offer.described) return [`Нищо не се прави. ${missingNoteText(offer.missing)} Не казвай, че се правят.`];
    const labels = english ? "`Image 1: …` или `Video: …`" : "`Картинка 1: …` или `Видео: …`";
    return [
      `Нищо не се прави, защото в предишния ти отговор няма описание във формата ${labels}. Напиши описанията отново в този формат, всяко на свой ред, и завърши с реда ${line}`,
    ];
  }
  return [];
}

// The system rule that lets the answering model order pictures and video.
// Without it the honest answer was "I can't" (27.11.2026). Only the kinds this
// account can make are named; a member is told the price.
export function mediaToolsRule({ images = false, video = false, member = false, english = false } = {}) {
  if (!images && !video) return "";
  const both = images && video;
  const labels = english
    ? [images ? "`Image 1:`, `Image 2:`" : "", video ? "`Video:`" : ""]
    : [images ? "`Картинка 1:`, `Картинка 2:`" : "", video ? "`Видео:`" : ""];
  const kinds = english
    ? [images ? "the picture, the pictures" : "", video ? "the video" : "", both ? "the picture and the video, the pictures and the video" : ""]
    : [images ? "картинката, картинките" : "", video ? "видеото" : "", both ? "картинката и видеото, картинките и видеото" : ""];
  const line = english ? "`Next: say yes and I will make …`" : "`Следва: напиши „да“ и правя …`";
  const yes = english ? "„yes“" : "„да“";
  // Every script column the extractor knows (SCRIPT_LABEL), so the model
  // avoids each of them (review r2: a „Глас:“ line made an ad a script).
  const columns = english
    ? "„Sound:“, „Audio:“, „Voice:“, „VO:“, „Narrator:“ или „On-screen text:“"
    : "„Звук:“, „Аудио:“, „Глас:“, „Диктор:“ или „Текст на екрана:“";
  const what = both ? "картинки или видео" : images ? "картинки" : "видео";
  // Only a video is one thing: „го“, „то е“ (review r2).
  const one = !images;
  return [
    both
      ? "[КАРТИНКИ И ВИДЕО] NovariumAI рисува картинки и прави кратко видео до 8 секунди със звук."
      : images
        ? "[КАРТИНКИ] NovariumAI рисува картинки."
        : "[ВИДЕО] NovariumAI прави кратко видео до 8 секунди със звук.",
    `${one ? "Ти не го правиш в текста, а го поръчваш" : "Ти не ги правиш в текста, а ги поръчваш"}: когато човекът поиска ${what} или ${
      one ? "то е нужно" : "те са нужни"
    } за задачата му, напиши подробно описание на отделен ред, който започва с ${labels
      .filter(Boolean)
      .join(" или ")} (най-много ${both ? "4 картинки и 1 видео" : images ? "4 картинки" : "1 видео"})${
      images ? ", с празен ред между описанията" : ""
    }.`,
    `Описанието казва какво се вижда, стил, цветове и формат; текст, който трябва да се вижда, сложи в кавички${
      video ? `; звукът и музиката са в същия ред, никога на отделен ред ${columns} (такъв ред прави отговора сценарий и нищо не се прави)` : ""
    }.`,
    "Тези етикети са само за описание, което да се направи: никога за сценарий, отчет или списък със съществуващи видеа.",
    `Завърши точно с ред ${line}, като назовеш само описаното: ${kinds.filter(Boolean).join(", ")}; след него не пиши нищо.`,
    `${one ? "Под отговора излиза бутон; натискане или кратко" : "Под отговора излизат бутони; натискане или кратко"} ${yes} веднага след такъв отговор ${
      one ? "го" : "ги"
    } прави. Това е работа на страницата, а не фонова работа, която обещаваш.`,
    `Не казвай, че не можеш да правиш ${what}, и не казвай, че ${one ? "е готово, преди да се покаже" : "са готови, преди да се покажат"}.`,
    member
      ? [
          images ? `Картинка струва ${PUBLIC_IMAGE_CREDITS} единици.` : "",
          video ? `Видео струва ${PUBLIC_VIDEO_CREDITS} единици (връщат се, ако видеото не стане).` : "",
        ]
          .filter(Boolean)
          .join(" ")
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}
