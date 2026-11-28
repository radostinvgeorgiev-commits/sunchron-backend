// The person's short agreement to the step the previous answer proposed
// („да“, „ДА ДАВАЙ“, „Да, направи ги“, „yes go ahead“, „Ja“, „Oui“…), and an
// agreement with something added („да, но по-кратко“). Every check here is
// linear in the message: its length is checked first, and the words are
// compared with fixed lists, never with a pattern that repeats a group.

const SHORT_YES_LENGTH = 80;
const YES_WITH_ADDITION_LENGTH = 200;
// Six, as the owner writes a yes in capitals („ДА ДАВАЙ НАПРАВИ ГИ ВСИЧКИТЕ
// СЕГА“, review r5); every word must still be a yes word.
const MAX_YES_WORDS = 6;

// The marks that ask back („Да?“, „نعم؟“, „Да❓“, „ДА⁉️“): a yes with one of
// them never starts paid pictures or video (review r5: the Arabic and Urdu
// mark and the emoji ones a phone keyboard offers). readWords drops the
// emoji's variation selector first.
export const ASKS_BACK = /[?？¿؟❓❔⁇⁈⁉‽﹖]/u;

// Words that alone agree or say "go on", in the site's page languages (bg,
// en, de, es, fr, it, ro) and in the content languages that have a common
// one (uk, tr, zh, hi, ur, ar). Never Russian. They are compared after
// normalising, so „d'accord“ is „daccord“, and a few fixed phrases are one
// word („vas-y“ is „vasy“, „разбира се“ is „разбирасе“, see PHRASES).
const CORE_WORDS = new Set([
  // Bulgarian, also with „и“ for „й“ („ДАВАИ“, „ОКЕИ“) and typed in Latin
  // letters („DA DAVAI“, „DA DAWAI“, „NAPRAWI GI“), as the owner writes
  "да", "давай", "ок", "окей", "добре", "хайде", "действай", "продължи", "направи", "прави",
  "изпълни", "избери", "пускай", "става", "може", "разбирасе",
  "даваи", "океи", "хаиде", "действаи", "пускаи",
  "davai", "davay", "davaj", "dawai", "dawaj", "haide", "hajde", "deistvai", "deystvai", "dobre",
  "okei", "okej", "okey", "napravi", "naprawi", "pravi", "prawi", "hayde", "stava", "moje",
  // English
  "yes", "yeah", "yep", "yup", "sure", "ok", "okay", "alright", "go", "proceed", "continue", "do", "make",
  "create", "absolutely", "ofcourse", "goforit", "soundsgood", "letsdoit", "letsgo",
  // German
  "ja", "jawohl", "klar", "gerne", "los", "mach", "erstelle", "weiter", "losgehts",
  // Spanish
  "sí", "si", "vale", "claro", "dale", "adelante", "haz", "hazlo", "hazlas", "hazlos",
  // French
  "oui", "ouais", "daccord", "vasy", "allez", "allezy", "fais",
  // Italian
  "sì", "certo", "vai", "procedi", "fai", "fallo", "falle",
  // Romanian
  "da", "sigur", "bine", "hai", "fă", "fa",
  // Ukrainian, Turkish, Chinese, Hindi, Urdu, Arabic
  "так", "evet", "tamam", "好", "好的", "是", "是的", "行", "可以", "हाँ", "हां", "ہاں", "جی", "نعم",
]);

// Words that may come with a core word: „да, моля“, „направи ги всичките“,
// „yes go ahead“, „go on“, „Супер, давай“, „ja, bitte“, „fais-le“, „s'il vous
// plaît“, „Sì, grazie“, „te rog“…
const FILLER_WORDS = new Set([
  "моля", "ги", "го", "я", "тях", "сега", "веднага", "всичко", "всички", "всичките", "двете", "и",
  "препоръката", "варианта", "супер", "чудесно", "благодаря", "мерси", "точно", "така",
  // „Да, искам“; never right before „да“ („Искам да…“ is a request, see
  // agreement).
  "искам",
  "gi", "sega", "vsichko", "vsichki", "molya", "molia",
  "it", "them", "ahead", "on", "please", "now", "all", "of", "both", "then", "thanks", "perfect", "great",
  "definitely",
  "bitte", "es", "sie", "alles", "danke",
  "por", "favor", "lo", "todo", "que", "gracias",
  "le", "la", "les", "sil", "te", "vous", "plait", "plaît", "merci",
  "per", "favore", "pure", "grazie",
  "rog", "o", "tot", "mulțumesc", "multumesc",
]);

// Fixed phrases read as one word, at most three words long.
const PHRASES = [
  [["vas", "y"], "vasy"],
  [["allez", "y"], "allezy"],
  [["разбира", "се"], "разбирасе"],
  [["of", "course"], "ofcourse"],
  [["go", "for", "it"], "goforit"],
  [["sounds", "good"], "soundsgood"],
  [["lets", "do", "it"], "letsdoit"],
  [["lets", "go"], "letsgo"],
  [["los", "gehts"], "losgehts"],
  [["thank", "you"], "thanks"],
  [["sure", "thing"], "sure"],
  [["all", "right"], "alright"],
];

// „ok, thanks“ or „добре, благодаря“ closes a topic as often as it agrees, so
// a thanks with no other agreement than these is not a short yes: it never
// starts paid pictures or video.
const THANKS_WORDS = new Set(["благодаря", "мерси", "thanks", "danke", "gracias", "merci", "grazie", "mulțumesc", "multumesc"]);
const ACKNOWLEDGE_WORDS = new Set([
  "ок", "окей", "океи", "добре", "dobre", "okei", "okej", "okey", "ok", "okay", "alright", "vale", "daccord", "bine",
  "klar", "tamam", "好", "行", "става", "stava",
]);

// The core words that only agree: a yes with something added may start with
// one of them right away („ДА ТЕКСТА Е ОК НО…“).
const AGREEMENT_WORDS = new Set([
  "да", "ок", "окей", "океи", "добре", "разбирасе", "dobre", "okei", "okej", "yes", "yeah", "yep", "yup", "sure", "ok",
  "okay",
  "absolutely", "ofcourse", "goforit", "soundsgood", "letsdoit", "letsgo", "ja", "jawohl", "klar", "gerne",
  "losgehts", "sí", "vale", "claro", "oui", "ouais", "daccord", "vasy", "allezy", "sì", "certo",
  "sigur", "bine", "так", "evet", "tamam", "好", "好的", "是", "是的", "行", "可以", "हाँ", "हां", "ہاں",
  "جی", "نعم", "okey", "alright",
]);
// The Bulgarian "go ahead" words: whatever follows one of them is the
// addition („ДАВАЙ НА АНГЛИЙСКИ“, „ДАВАЙ ПО-КРАТКО“, „ХАЙДЕ С ВИДЕО“), but
// „да“, the particle of another proposal („Давай да видим пощата“).
const BULGARIAN_GO_AHEAD_WORDS = new Set([
  "давай", "даваи", "хайде", "хаиде", "действай", "действаи", "пускай", "пускаи",
  "davai", "davay", "davaj", "dawai", "dawaj", "haide", "hajde", "hayde", "deistvai", "deystvai",
]);
// Words that agree or say "go ahead" but also start other sentences: „Go to
// the settings“, „Hai visto…“, „Vai alla pagina“, „Si quieres…“, „Става дума
// за…“, „Може ли…“. They start a yes with something added only when a comma
// or a dash follows them, or a conjunction or another agreeing word („Go
// ahead but shorter“, „Los, aber kürzer“).
const GO_AHEAD_WORDS = new Set(["става", "може", "stava", "moje", "go", "los", "dale", "si", "allez", "vai", "da", "hai"]);
const CONJUNCTIONS = new Set([
  "но", "ама", "ала", "обаче", "а", "и", "само", "but", "and", "though", "aber", "und", "doch",
  "pero", "y", "mais", "et", "ma", "e", "però", "dar", "și", "însă",
]);
// In Bulgarian „да“ is also the particle before a verb: „Да не го правиш“,
// „Да изчакаме до утре“, „Да видим пощата“, „Да направиш ли…?“ are no yes.
// With nothing between them, „да“ followed by „не“, „ли“, a short pronoun, a
// common verb form („видим“, „направиш“, „направя“) or a longer word ending
// in „-ме“ („изчакаме“, „пробваме“) is that particle. A noun is not („ДА
// ПРОБЛЕМ НЯМА“, „ДА ВРЕМЕ Е“, „ДА ИМЕ НЕ ТРЯБВА“, review r2): such a yes
// comes with an addition, which only changes what the model is told.
const PARTICLE_NEXT_WORDS = new Set([
  "не", "ли", "го", "я", "ги", "ми", "ти", "му", "ѝ", "ни", "ви", "им", "се", "си", "сме", "сте",
  // A verb's "we" form and its "you" form („видим“, „видиш“).
  ...[
    "видим", "направим", "правим", "проверим", "помислим", "оставим", "отложим", "сменим", "решим",
    "обсъдим", "изпратим", "пратим", "качим", "уточним", "мислим", "пуснем", "започнем", "почнем",
    "спрем", "кажем", "напишем", "пишем", "погледнем", "разберем", "бъдем",
  ].flatMap((we) => [we, `${we.slice(0, -1)}ш`]),
  "изчакаш", "почакаш", "чакаш", "пробваш", "опиташ", "питаш", "прегледаш", "публикуваш",
  // The "I" form of a question („Да направя ли картинките?“).
  "видя", "направя", "правя", "проверя", "изчакам", "пробвам", "питам", "напиша", "кажа", "пусна",
]);
const isParticleVerb = (word) => PARTICLE_NEXT_WORDS.has(word) || (word.length >= 6 && word.endsWith("ме"));

// The message as words: NFC, lower case, apostrophes and invisible marks
// dropped („d'accord“ is „daccord“), every other punctuation mark, quote,
// dash or emoji a break („ДА!!!“ is „да“, „Да,но“ is „да“, „но“). Each word
// says whether such a mark came right after it; the list says whether a
// mark that asks back came after its last word (`asks`: „Да?“, „ок?“,
// „Yes?“, „نعم؟“, „Да❓“).
function readWords(text) {
  const tokens =
    text
      .normalize("NFC")
      .toLowerCase()
      .replace(/[\p{Cf}\u{FE0E}\u{FE0F}\u{20E3}'’ʼ‘`´]/gu, "")
      .match(/[\p{L}\p{M}\p{N}]+|[^\s\p{L}\p{M}\p{N}]+/gu) || [];
  const read = [];
  let asks = false;
  // A Spanish „¿“ opens a question wherever it stands („¿Sí“).
  let opened = false;
  for (const token of tokens) {
    if (/^[\p{L}\p{M}\p{N}]/u.test(token)) {
      read.push({ word: token, mark: false });
      asks = false;
    } else {
      if (read.length) read.at(-1).mark = true;
      asks ||= ASKS_BACK.test(token);
      opened ||= token.includes("¿");
    }
  }
  const words = [];
  for (let index = 0; index < read.length; index += 1) {
    const phrase = PHRASES.find(([parts]) => parts.every((part, at) => read[index + at]?.word === part));
    if (phrase) {
      const [parts, word] = phrase;
      words.push({ word, mark: read[index + parts.length - 1].mark });
      index += parts.length - 1;
    } else {
      words.push(read[index]);
    }
  }
  words.asks = asks || opened;
  return words;
}

// Whether these words are one to six yes words, at least one of them a core
// word: "yes" when they agree, "thanks" when they are a thanks that only
// acknowledges („ok thanks“, „мерси, ок“), "" otherwise.
function agreement(words) {
  if (!words.length || words.length > MAX_YES_WORDS) return "";
  if (!words.every((word) => CORE_WORDS.has(word) || FILLER_WORDS.has(word))) return "";
  if (words.some((word, at) => word === "искам" && words[at + 1] === "да")) return "";
  const core = words.filter((word) => CORE_WORDS.has(word));
  if (!core.length) return "";
  return words.some((word) => THANKS_WORDS.has(word)) && core.every((word) => ACKNOWLEDGE_WORDS.has(word))
    ? "thanks"
    : "yes";
}

// Whether these words are a bare agreement, not a thanks that only
// acknowledges.
const agrees = (words) => agreement(words) === "yes";

// True when the whole message is a bare agreement. „да, но на английски“,
// „не“, „no“, „да видим пощата“ and „ok thanks“ are not, and neither is one
// that asks back („Да?“, „ок?“, „Yes?“, review r2): it never starts paid
// pictures or video, and the model gets the step with it.
export function isShortYes(text) {
  if (typeof text !== "string" || text.length > SHORT_YES_LENGTH) return false;
  const words = readWords(text);
  return !words.asks && agrees(words.map(({ word }) => word));
}

// The words of a message of at most 80 characters as isShortYes reads them,
// or null for anything longer or a message that asks back (the yes that
// names what to make, „направи картинките“, is read from them in
// chatMediaProposals.js).
export function shortMessageWords(text) {
  if (typeof text !== "string" || text.length > SHORT_YES_LENGTH) return null;
  const words = readWords(text);
  return words.asks ? null : words.map(({ word }) => word);
}

// Whether words a yes may contain are a bare agreement (see agrees), and
// whether one word is a yes word at all.
export const isBareAgreement = (words) => Array.isArray(words) && agrees(words);
export const isYesWord = (word) => CORE_WORDS.has(word) || FILLER_WORDS.has(word);

// An agreement with something added: at most 200 characters, not a bare
// yes, and it starts by agreeing („ДА ТЕКСТА Е ОК НО СМЕНИ ЗАГЛАВИЕТО“, „да,
// но по-кратко“, „ok, now in English“, „ДАВАЙ НА АНГЛИЙСКИ“, „Да?“), or it is
// a thanks that only acknowledges („мерси, ок“): the model then gets the step
// and decides. „Да не го правиш“, „Да изчакаме до утре“ and „Давай да видим
// пощата“ do not agree; „Go to the settings“ and „Hai visto…?“ start a new
// request.
export function yesWithAddition(text) {
  if (typeof text !== "string" || text.length > YES_WITH_ADDITION_LENGTH || isShortYes(text)) {
    return false;
  }
  const words = readWords(text);
  if (agreement(words.map(({ word }) => word)) === "thanks") return true;
  const [first, second] = words;
  if (!first) return false;
  if (AGREEMENT_WORDS.has(first.word)) {
    if (first.word !== "да" || first.mark || !second) return true;
    return !isParticleVerb(second.word);
  }
  if (BULGARIAN_GO_AHEAD_WORDS.has(first.word)) return !second || first.mark || second.word !== "да";
  if (!GO_AHEAD_WORDS.has(first.word) || !second) return false;
  return (
    first.mark ||
    CONJUNCTIONS.has(second.word) ||
    FILLER_WORDS.has(second.word) ||
    (CORE_WORDS.has(second.word) && second.word !== "да")
  );
}
