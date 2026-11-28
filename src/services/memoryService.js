import { createHash, randomUUID } from "node:crypto";
import { resolveMemoryBackend } from "../config/memoryBackend.js";
import {
  CANONICAL_PROJECT_MEMORY_ID,
  PROJECT_DEFINITION,
  isSupersededProjectDefinition,
} from "../config/projectIdentity.js";
import { createFirestoreMemoryStore } from "./firestoreMemoryStore.js";

const OWNER_ID = process.env.MEMORY_OWNER_ID || "primary-user";
const MAX_MEMORIES = 200;
const MAX_CONVERSATION_MESSAGES = 20;
const MAX_CONVERSATIONS = 50;
const VALID_SCOPES = new Set(["personal", "project"]);
let firestoreStore = null;
let firestoreStoreConfiguration = null;
let firestoreStoreOverride = null;

export function setFirestoreMemoryStoreForTests(store) {
  firestoreStoreOverride = store || null;
  firestoreStore = null;
  firestoreStoreConfiguration = null;
}

// A memory shared with „Питай моя аватар“ follows its memory (review of
// #605): the avatar link listens here (server.js). Every change to the
// person's memories is announced, by any path (the panel, „Запомни“,
// „Забрави“, „Забрави всичко“, the connector), with the texts the memories
// have now, so a shared line whose memory is gone or changed leaves the
// visitors' text. `renamed` names only the same words in other capitals.
let memoryChangeListener = null;

export function setMemoryChangeListener(listener) {
  memoryChangeListener = typeof listener === "function" ? listener : null;
}

function renamedPairs(from, to) {
  if (typeof from !== "string" || typeof to !== "string" || from === to) return [];
  return [
    { from, to },
    { from: cleanMemoryFact(from), to: cleanMemoryFact(to) },
  ];
}

// Every text a memory of this person has now, as stored and as the memory
// panel shows and shares it (a split or a joined card), and apart the cards
// alone: a line moves only to words a card shows (third review of #605).
async function currentMemoryTexts(ownerId) {
  const hits = await fetchProfileHits(ownerId);
  const texts = new Set();
  const seenKeys = new Set();
  const memories = [];
  for (const hit of hits) {
    const memory = hydrateMemory(hit);
    if (!memory) continue;
    texts.add(memory.fact);
    if (seenKeys.has(memory.memoryKey)) continue;
    seenKeys.add(memory.memoryKey);
    memories.push(memory);
  }
  const cards = consolidateMemoryView(memories).map((memory) => memory.fact);
  for (const fact of cards) texts.add(fact);
  return { texts: [...texts], cards };
}

async function announceMemoryChange(ownerId, renamed = []) {
  if (!memoryChangeListener) return;
  try {
    await memoryChangeListener(ownerId, {
      renamed,
      currentTexts: () => currentMemoryTexts(ownerId),
    });
  } catch (error) {
    // The memory change itself stands; the person can still clean the
    // visitors' text by hand in „Питай моя аватар“.
    console.error("[Memory] shared line not updated", {
      name: error?.name,
      code: error?.code,
    });
  }
}

export function profileMemoryDocumentId(ownerId, memoryKey) {
  const owner = String(ownerId || "").trim();
  const key = String(memoryKey || "").trim();
  if (!owner || !key) {
    throw new TypeError("Profile memory document ID requires owner and key.");
  }

  return `profile-${createHash("sha256")
    .update(owner)
    .update("\0")
    .update(key)
    .digest("hex")}`;
}

function getMemoryBackendOrThrow() {
  const backend = resolveMemoryBackend(process.env);
  if (!backend) {
    const error = new Error("Невалиден MEMORY_BACKEND.");
    error.code = "MEMORY_UNAVAILABLE";
    throw error;
  }
  return backend;
}

function getFirestoreStoreOrThrow() {
  if (firestoreStoreOverride) return firestoreStoreOverride;
  getMemoryBackendOrThrow();
  const configuration = [
    process.env.GOOGLE_CLOUD_PROJECT,
    process.env.GCLOUD_PROJECT,
    process.env.GCP_PROJECT_ID,
    process.env.FIRESTORE_DATABASE_ID,
    process.env.FIRESTORE_PROFILE_COLLECTION,
    process.env.FIRESTORE_CONVERSATION_COLLECTION,
  ].join("\0");
  if (!firestoreStore || firestoreStoreConfiguration !== configuration) {
    firestoreStore = createFirestoreMemoryStore({ env: process.env });
    firestoreStoreConfiguration = configuration;
  }
  return firestoreStore;
}

function normalizeFact(fact) {
  return fact.trim().replace(/\s+/g, " ").toLocaleLowerCase("bg-BG");
}

function cleanMemoryFact(fact) {
  return fact
    .trim()
    .replace(/^[„“"'’]+|[„“"'’]+$/gu, "")
    .replace(/\s+/g, " ")
    .replace(/\s+(?:запомни|запази)\s+това[.!?]*$/iu, "")
    .replace(/[.!?]+$/u, "")
    .trim();
}

export function normalizeProfileMemoryDraft(fact, requestedScope = "personal") {
  const cleanFact = typeof fact === "string" ? cleanMemoryFact(fact) : "";
  if (!cleanFact || cleanFact.length > 500) {
    const error = new Error(
      "Фактът за паметта трябва да бъде между 1 и 500 знака.",
    );
    error.code = "INVALID_MEMORY";
    throw error;
  }
  if (!VALID_SCOPES.has(requestedScope)) {
    const error = new Error("Невалиден тип памет.");
    error.code = "INVALID_MEMORY";
    throw error;
  }
  return Object.freeze({ fact: cleanFact, scope: requestedScope });
}

const MAX_LIST_FACTS = 30;

function splitMemoryFacts(value) {
  const normalized = value.replace(/\r\n/g, "\n").trim();
  const lines = normalized
    .split(/\n+/u)
    .map((line) => line.replace(/^\s*(?:[-*•]|(?:\d+)[.)])\s*/u, "").trim())
    .filter(Boolean);
  const candidates =
    lines.length > 1 ? lines : normalized.split(/\s*;\s*/u).filter(Boolean);

  return [...new Set(candidates.map(cleanMemoryFact).filter(Boolean))].slice(
    0,
    MAX_LIST_FACTS,
  );
}

function normalizedWords(fact) {
  return normalizeFact(cleanMemoryFact(fact))
    .replace(/[„“"'’.,!?;:]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function deriveMemoryMetadata(fact, requestedScope = "personal") {
  const normalized = normalizedWords(fact);
  const scope = VALID_SCOPES.has(requestedScope) ? requestedScope : "personal";

  if (scope === "project") {
    const projectName = normalized.match(
      /^(?:проектът|проекта|името на проекта)\s+(?:се казва|е)\s+/u,
    );
    if (projectName) {
      return {
        memoryKey: "project:identity:name",
        category: "identity",
        scope,
      };
    }
    if (/(?:целта|текущата цел|приоритетът) на проекта/u.test(normalized)) {
      return { memoryKey: "project:goal:current", category: "goal", scope };
    }
    if (
      /(?:инфраструктура|google\s*cloud|cloud\s*run|github|firestore)/u.test(
        normalized,
      )
    ) {
      return {
        memoryKey: `project:infrastructure:${normalized
          .replace(/\s+/g, "-")
          .slice(0, 80)}`,
        category: "infrastructure",
        scope,
      };
    }
    return {
      memoryKey: `project:fact:${normalized}`,
      category: "project-fact",
      scope,
    };
  }

  if (/^(?:казвам се|името ми е|аз съм)\s+/u.test(normalized)) {
    return { memoryKey: "personal:identity:name", category: "identity", scope };
  }
  if (
    /^(?:живея|местоживеенето ми е|градът ми е)\s+(?:във?|на)?\s*/u.test(
      normalized,
    )
  ) {
    return {
      memoryKey: "personal:location:residence",
      category: "location",
      scope,
    };
  }
  if (
    /^(?:любим(?:ият|ия)?\s+ми\s+цвят(?:ът)?|предпочитаният ми цвят)\s+(?:вече\s+)?е(?:\s|$)/u.test(
      normalized,
    )
  ) {
    return {
      memoryKey: "personal:preference:favorite-color",
      category: "preference",
      scope,
    };
  }
  const workHolding = normalized.match(
    /^(?:аз\s+)?имам\s+(?:бизнес\s+с\s+)?(фирма|магазин|заведение|бунгала|къмпинг)(.*)$/u,
  );
  if (workHolding) {
    return {
      memoryKey: `personal:work:${workHolding[1]}:${
        workHolding[2].trim().replace(/\s+/g, "-").slice(0, 80) || "general"
      }`,
      category: "work",
      scope,
    };
  }
  if (
    /^(?:(?:аз\s+)?се\s+интересувам|интересувам\s+се)\s+от\s+/u.test(normalized)
  ) {
    return {
      memoryKey: `personal:interest:${normalized
        .replace(
          /^(?:(?:аз\s+)?се\s+интересувам|интересувам\s+се)\s+от\s+/u,
          "",
        )
        .replace(/\s+/g, "-")
        .slice(0, 100)}`,
      category: "interest",
      scope,
    };
  }

  // "моят/моята/моето/моите X е VALUE" — topic-based key (without the value) so
  // that saving a new value for the same topic correctly supersedes the old one.
  const myThing = normalized.match(
    /^(?:моят|моята|моето|моите)\s+(.{2,80}?)\s+(?:вече\s+)?е(?:\s|$)/u,
  );
  if (myThing) {
    return {
      memoryKey: `personal:property:моят-${myThing[1]
        .trim()
        .replace(/\s+/g, "-")
        .slice(0, 80)}`,
      category: "personal-fact",
      scope,
    };
  }

  const personalProperty = normalized.match(
    /^(.{2,80}?\s+ми)\s+(?:вече\s+)?е(?:\s|$)/u,
  );
  if (personalProperty) {
    return {
      memoryKey: `personal:property:${personalProperty[1]}`,
      category: "personal-fact",
      scope,
    };
  }

  return {
    memoryKey: `personal:fact:${normalized}`,
    category: "personal-fact",
    scope,
  };
}

export function extractPersistentMemoryCommand(message) {
  const text = message.trim();
  const projectPatterns = [
    /^запомни\s+за\s+проекта\s*:\s*([\s\S]+)$/iu,
    /^запомни\s+за\s+проекта\s*,?\s+че\s+([\s\S]+)$/iu,
    /^поправка\s+за\s+проекта\s*:\s*([\s\S]+)$/iu,
  ];
  const personalPatterns = [
    /^запомни(?:\s+за\s+бъдещи\s+разговори)?\s*:\s*([\s\S]+)$/iu,
    /^запомни(?:\s+за\s+бъдещи\s+разговори)?\s*,?\s+че\s+([\s\S]+)$/iu,
    /^запази\s+в\s+постоянната\s+памет\s*:\s*([\s\S]+)$/iu,
    /^запомни\s+в\s+постоянната\s+ми\s+памет\s*:\s*([\s\S]+)$/iu,
    /^поправка\s*:\s*([\s\S]+?)(?:\s+(?:запомни|запази)\s+това[.!?]*)?$/iu,
    // The same command in the site's other languages, as the memory panel
    // names it there („Remember: …“, „Merken: …“ …).
    /^(?:remember|merken|merk\s+dir|recordar|recuerda|retenir|retiens|ricorda|ricordare|[țţt]ine\s+minte)\s*:\s*([\s\S]+)$/iu,
  ];

  for (const pattern of projectPatterns) {
    const match = text.match(pattern);
    const fact = match?.[1] ? cleanMemoryFact(match[1]) : "";
    if (fact) return { fact, scope: "project" };
  }
  for (const pattern of personalPatterns) {
    const match = text.match(pattern);
    const fact = match?.[1] ? cleanMemoryFact(match[1]) : "";
    if (fact) return { fact, scope: "personal" };
  }
  return null;
}

const BULK_MEMORY_PATTERNS = Object.freeze([
  {
    scope: "project",
    pattern: /^запомни\s+(?:следното\s+)?за\s+проекта\s*:\s*([\s\S]+)$/iu,
  },
  {
    scope: "project",
    pattern: /^запомни\s+за\s+проекта\s+следното\s*:\s*([\s\S]+)$/iu,
  },
  {
    scope: "personal",
    pattern: /^запомни\s+следното\s+за\s+мен\s*:\s*([\s\S]+)$/iu,
  },
  {
    scope: "personal",
    pattern: /^запомни\s+за\s+мен\s+следното\s*:\s*([\s\S]+)$/iu,
  },
  {
    scope: "personal",
    pattern: /^запомни\s+следното\s*:\s*([\s\S]+)$/iu,
  },
]);

// The person asks to see the fact first or to be asked before it is written,
// in any of the site's languages („не го записвай още“, „do not save it yet“,
// „speichere es noch nicht“, „no lo guardes“, „ne l'enregistre pas“, „non
// salvarlo“, „nu o salva“). Only words about saving count, so a preference
// such as „недей да ми звъниш след 22 ч.“ is still a plain fact.
const WAIT_FOR_MEMORY_CONFIRMATION = new RegExp(
  [
    String.raw`не\s+(?:го\s+|я\s+|ги\s+)?(?:записвай|запазвай|запомняй|променяй)`,
    String.raw`(?:недей|без)\s+да\s+(?:го\s+|я\s+|ги\s+)?(?:записваш|запазваш|запишеш|запазиш|запомняш|запомниш)`,
    String.raw`преди\s+(?:да\s+)?(?:запис|запиш|запаз|потвърд)`,
    String.raw`(?:поискай|изчакай|чакай)\s+(?:моето\s+|ми\s+)?(?:потвърждение|одобрение|съгласие)`,
    String.raw`предложи\s+да\s+запомниш`,
    String.raw`(?:първо|преди\s+това)\s+(?:ми\s+)?покажи|покажи\s+ми\s+(?:първо|какво\s+(?:ще|би))`,
    String.raw`чакай\s+да\s+(?:ти\s+)?кажа`,
    String.raw`(?:don[’']?t|do\s+not|never)\s+(?:save|write|store)`,
    String.raw`ask\s+(?:me\s+)?first|check\s+with\s+me\s+first|(?:show|tell)\s+me\s+first`,
    String.raw`wait\s+for\s+(?:my\s+)?(?:confirmation|approval|ok\b|okay)`,
    String.raw`before\s+(?:you\s+)?(?:save|saving|write|writing|store|storing)`,
    String.raw`nicht\s+speicher|speicher\p{L}*\s+(?:es\s+|das\s+)?(?:noch\s+)?nicht`,
    String.raw`frag\p{L}*\s+mich\s+(?:zuerst|erst|vorher)|warte\p{L}*\s+auf\s+meine`,
    String.raw`no\s+(?:lo\s+|la\s+|los\s+|las\s+)?(?:guardes|grabes|almacenes)`,
    String.raw`preg[uú]ntame\s+(?:primero|antes)|espera\s+(?:a\s+)?mi\s+(?:confirmaci[oó]n|aprobaci[oó]n|ok\b)`,
    String.raw`(?:ne\s+(?:l['’]\s*|le\s+|la\s+|les\s+)?|n['’])(?:enregistre|sauvegarde|m[ée]morise|retiens)\s+(?:pas|rien)`,
    String.raw`demande[\s-]moi\s+(?:d['’]abord|avant)|attends\s+(?:ma\s+)?confirmation`,
    String.raw`non\s+(?:lo\s+|la\s+|li\s+|le\s+)?(?:salvar|memorizzar|registrar)`,
    String.raw`chiedimi\s+prima|aspetta\s+(?:la\s+)?(?:mia\s+)?conferma`,
    String.raw`nu\s+(?:o\s+|îl\s+|il\s+|le\s+|i\s+)?(?:salva|memora|[îi]nregistra)`,
    String.raw`[îi]ntreab[ăa]-?m[ăa]\s+(?:mai\s+)?[îi]nt[âa]i|a[șşs]teapt[ăa]\s+confirmarea`,
    // By meaning, in any form (review of #605): confirming, approving, being
    // asked or shown first, waiting. A real fact with one of these words only
    // gets the one-time confirmation.
    String.raw`потвърд|одобр|(?:^|[^\p{L}])(?:по)?питай(?:те)?(?:[^\p{L}]|$)|(?:^|[^\p{L}])(?:по|из)?чакай(?:те)?(?:[^\p{L}]|$)|покажи(?:\s+ми)?\s+какво`,
    String.raw`confirm|approv|ask\s+me|until\s+I(?:[^\p{L}]|$)|(?:^|[^\p{L}])wait(?:[^\p{L}]|$)|show\s+me\s+what|let\s+me\s+(?:check|see|look)`,
    String.raw`best[äa]tig|frag\p{L}*\s+mich|(?:^|[^\p{L}])wart(?:e|et)(?:[^\p{L}]|$)|zeig\p{L}*\s+mir`,
    String.raw`pregunt|apruebo|aprobaci|aprueba|mu[ée]strame`,
    String.raw`demande|(?:^|[^\p{L}])attend(?:s|ez)(?:[^\p{L}]|$)|montre[\s-]moi`,
    String.raw`chied|conferm|aspett|mostrami|approva`,
    String.raw`[îi]ntreab|a[șşs]teapt|arat[ăa]-?mi|aprob`,
    // „Not yet“ in any of the site's languages, and not-writing in other
    // words („не го пиши още“, „don't add it yet“, „засега“).
    String.raw`не\s+(?:го\s+|я\s+|ги\s+)?(?:пиши|добавяй|слагай|пази|вкарвай|помни)|(?:^|[^\p{L}])(?:още\s+не|не\s+още|засега)(?:[^\p{L}]|$)|първо\s+ми\s+кажи`,
    String.raw`not\s+yet|hold\s+off|for\s+now|don[’']?t\s+(?:add|keep|put|record|remember|note|write|save|store)|first\s+tell\s+me|tell\s+me\s+first|think\s+about\s+it|let\s+me\s+think`,
    String.raw`noch\s+nicht|todav[ií]a\s+no|a[uú]n\s+no|pas\s+encore|non\s+ancora|[îi]nc[ăa]\s+nu`,
    // Fifth review: no hurry, not sure, a moment, later, I will tell you or
    // check, in any of the site's languages. A fact the person is not sure of
    // („май е в 14 ч“, „maybe“, „I think“) also waits for the confirmation.
    String.raw`не\s+(?:се\s+)?бързай|без\s+бързане|няма\s+(?:за\s+)?бързане|не\s+е\s+спешно|не\s+бързаме|задръж`,
    String.raw`не\s+(?:съм|сме|е|са)\s+(?:\p{L}+\s+)?сигур|несигур|(?<![\p{L}])сигурно(?![\p{L}])|не\s+знам\s+(?:дали|кога|къде|точно|още)|(?<![\p{L}])май(?<!\d\s*май)\s+(?:е|ще|беше|съм|са|сме)(?![\p{L}])|може\s+би|вероятно|предполагам|мисля,?\s+че|ако\s+не\s+(?:греша|се\s+лъжа)|не\s+съм\s+100`,
    String.raw`(?<![\p{L}])(?:момент|моментче|секунд\p{L}*|сек)(?![\p{L}])|уточн|ще\s+(?:ти\s+|ви\s+)?(?:кажа|пиша|пратя|проверя|потвърдя|уточня|видя|реша|помисля|звънна|обадя|кажем|пишем|проверим|видим|решим)(?![\p{L}])|по[-\s]късно|по[-\s]нататък|по-натам|после\s+ще|ей\s+сега|след\s+малко`,
    String.raw`not\s+(?:\p{L}+\s+)?sure|unsure|not\s+100|not\s+certain|(?<![\p{L}])(?:maybe|perhaps|probably|possibly)(?![\p{L}])|(?<![\p{L}])i\s+(?:think|guess|believe)(?![\p{L}])|(?<![\p{L}])later(?![\p{L}])|double[-\s]?check|hang\s+on|hold\s+on|(?<![\p{L}])(?:one|a)\s+(?:sec|second|moment|min|minute)(?![\p{L}])|no\s+(?:rush|hurry)|don[’']?t\s+(?:rush|hurry)|(?:will|i[’']ll|i\s+will)\s+(?:tell|check|confirm|let|get\s+back|update)|let\s+you\s+know|get\s+back\s+to\s+you|(?<![\p{L}])(?:tbd|tbc)(?![\p{L}])|to\s+be\s+(?:confirmed|decided|determined)|need\s+to\s+(?:check|confirm|verify)`,
    String.raw`sp[äa]ter|vielleicht|wahrscheinlich|nicht\s+(?:ganz\s+)?sicher|(?<![\p{L}])moment(?![\p{L}])|sekunde|sag\s+(?:ich\s+)?dir\s+(?:sp[äa]ter|noch|bescheid)|melde\s+mich|ich\s+(?:pr[üu]fe|[üu]berlege|schaue)|[üu]berleg`,
    String.raw`m[áa]s\s+tarde|luego\s+te|quiz[áa]s?|tal\s+vez|a\s+lo\s+mejor|no\s+estoy\s+segur|un\s+(?:momento|segundo)|(?<![\p{L}])espera(?![\p{L}])|ya\s+te\s+(?:dir[ée]|digo|aviso|cuento)|te\s+aviso|lo\s+(?:confirmo|pienso|reviso)`,
    String.raw`plus\s+tard|peut[-\s][eê]tre|pas\s+(?:tout\s+[àa]\s+fait\s+)?s[uû]r|un\s+(?:moment|instant)|une\s+seconde|je\s+te\s+(?:dirai|dis|confirme)|je\s+(?:v[ée]rifie|confirme|r[ée]fl[ée]chis)|probablement`,
    String.raw`pi[uù]\s+tardi|(?<![\p{L}])(?:forse|magari)(?![\p{L}])|probabilmente|non\s+sono\s+sicur|un\s+(?:attimo|secondo)|ti\s+(?:dir[oò]|dico|faccio\s+sapere|confermo)|ci\s+penso`,
    String.raw`mai\s+t[âa]rziu|(?<![\p{L}])(?:poate|stai)(?![\p{L}])|probabil|nu\s+sunt\s+sigur|o\s+(?:clip[ăa]|secund[ăa])|[îi][țţt]i\s+spun|te\s+anun[țţt]|m[ăa]\s+g[âa]ndesc`,
  ].join("|"),
  "iu",
);
// „Поправка: …“ is a correction in the talk unless it ends with „запомни това“.
const BARE_MEMORY_CORRECTION =
  /^поправка\s*(?:за\s+проекта\s*)?:(?![\s\S]*(?:запомни|запази)\s+това[.!?]*$)/iu;
// After these a period does not end the sentence when a name or a place
// follows with a capital letter („ул. Раковски 5“, „гр. Варна“, „проф.
// Петров“). „г.“, „St.“ and „etc.“ are not here: before a capital letter they
// usually end the sentence („… 2015 г. Какво да му подаря?“).
const NAME_PREFIX_END =
  /(?:^|[^\p{L}])(?:ул|бул|гр|с|кв|ж\.к|бл|вх|ет|ап|обл|общ|пл|д-р|проф|инж|доц|акад|арх|г-н|г-жа|г-ца|св|mr|mrs|ms|dr|prof|sr|sra|mme|herr|fr|hr|sig|dott)\.$/iu;
// One capital letter and a period is an initial („Иван П. Петров“).
const INITIAL_END = /(?:^|[^\p{L}])\p{Lu}\.$/u;
// After these a period does not end the sentence when a small letter or a
// number follows („800 лв. на месец“, „2015 г. в Пловдив“, „бл. 5“, „3 p.m.
// on Friday“).
const ABBREVIATION_END =
  /(?:^|[^\p{L}])(?:ул|бул|гр|с|кв|ж\.к|бл|вх|ет|ап|обл|общ|пл|д-р|проф|инж|доц|акад|арх|г-н|г-жа|г-ца|св|г|гг|в|лв|ч|мин|сек|кг|км|м|см|мм|л|мл|бр|стр|т\.е|т\.нар|напр|вкл|прибл|др|тел|моб|mr|mrs|ms|dr|prof|no|nr|st|str|tel|etc|vs|approx|incl|min|hrs|km|kg|[ap]\.m|e\.g|i\.e|z\.b|bzw|usw|ca|ggf|evtl|sr|sra|p[áa]g|ecc|sig|dott|mme|mlle|env)\.$/iu;

// Whether a fact runs on into another sentence. A doubtful case counts as
// another sentence: the person then gets the one-time confirmation, and the
// rest of the message is never stored as part of the fact.
function hasSecondSentence(fact) {
  const text = String(fact || "");
  // Where the next word starts; it only moves forward, so the check stays
  // linear on long text.
  const word = /[\p{L}\p{N}]/gu;
  let nextWord = -1;
  for (const match of text.matchAll(/[.!?…]+/gu)) {
    const end = match.index + match[0].length;
    if (nextWord < end) {
      word.lastIndex = end;
      nextWord = word.exec(text)?.index ?? Infinity;
    }
    // The end of the fact, or only closing marks after it.
    if (nextWord === Infinity) break;
    // Only spaces, quotes and brackets may stand between the mark and the
    // next word; a dash, a star or a smiley there starts another sentence.
    const between = text.slice(end, nextWord);
    if (/[^\s„“”"'‘’«»()[\]]/u.test(between)) return true;
    const next = String.fromCodePoint(text.codePointAt(nextWord));
    if (match[0] !== ".") return true;
    // What goes on after a period is still the fact only when it is no
    // request or question („… 10 ч. провери календара ми“).
    if (requestStartsAt(text, nextWord)) return true;
    const before = text.slice(0, end);
    if (!/\s/u.test(between)) {
      // „1.5“, „28.11.2026“, „novariumai.com“, „p.m.“ go on; „чай.Провери“ does not.
      if (/\p{Lu}/u.test(next)) return true;
      continue;
    }
    if (/\p{Lu}/u.test(next)) {
      if (NAME_PREFIX_END.test(before) || INITIAL_END.test(before)) continue;
      return true;
    }
    if (ABBREVIATION_END.test(before) || INITIAL_END.test(before)) continue;
    return true;
  }
  return false;
}

// A second command inside the fact („… „Сменихме сметката. Запомни: …““).
const NESTED_MEMORY_COMMAND =
  /(?:^|[^\p{L}])(?:запомни|запази|remember|merken|merk\s+dir|recordar|recuerda|retenir|retiens|ricorda|ricordare|[țţt]ine\s+minte)\s*(?::|,?\s+(?:че|that|dass|que|che|că|ca)\s)/iu;

// A request to the assistant or a question to it, at the start of a fact, a
// list item or a clause (third, fourth and fifth review of #605). It fails
// closed: a real fact that happens to look like one only gets the one-time
// confirmation. Up to three leading words may come first („и също провери“,
// „а ти провери“, „моля те напомни“, „and also check“, „pls send“), then up
// to two short pronouns („и я прати“, „и му кажи“, „me“).
const LEAD_WORDS = String.raw`и|а|но|после|само|просто|моля\s+те|моля\s+ви|моля|също|още|сега|пак|ти|вие|нека|хайде|айде|ако\s+може|ако\s+обичаш|ако\s+обичате|плс|затова|освен\s+това|след\s+това|след\s+което|and|then|but|just|only|please|pls|plz|kindly|also|now|you|so|btw|oh|wanna|wanna\s+you`;
const SHORT_PRONOUNS = String.raw`ми|ти|му|ѝ|й|ни|ви|им|го|я|ги|се|си|ме|те`;
const REQUEST_LEAD = String.raw`(?:(?:${LEAD_WORDS})[\s,]+){0,3}(?:(?:${SHORT_PRONOUNS}|me|us)\s+){0,2}`;
// A request verb by its stem, in any form („провери“, „проверете“, „напомни
// ми“), or in English as a whole word; a question word by its stem („какво“,
// „каква“, „кога“, „what“, „what's“) or a question with a helping verb („is
// it“, „do I“).
const REQUEST_WORD = String.raw`(?:(?:кажи|кажете|провер|покаж|изпрат|прат|прочет|направ|напиш|намер|потърс|търс|пусн|отвор|създа|добав|изтри|изтрий|напомн|разкаж|дай|дайте|обясн|превед|сравн|отговор|запиш|резервир|поръча|купи|плати|звънн|обад|уведом|подготв|изчисл|пресметн|сметн|помогн|погледн|предлож|препоръч|обобщ|сложи|върни|спри|махни|включ|изключ|питай|попитай|подсет|измисл|виж|вижте|ела|елате)\p{L}*|(?:tell|show|check|send|read|make|write|find|search|open|create|add|delete|remove|remind|email|e-mail|text|call|book|buy|order|schedule|set|give|get|list|summari[sz]e|translate|explain|draft|reply|answer|forward|play|start|stop|cancel|update|change|fix|help|compare|calculate|plan|prepare|look|let|let['’]s|ask|bring|put|keep|note|save|turn|go|try|see|watch|wake|suggest|recommend|share|print|ping|message|notify|review|research|pick|grab|organi[sz]e|sort|draw|generate|convert|recap|outline)(?![\p{L}'’-])|(?:как|кой|коя|кое|кои|чий|чия|чие|чии|защо|колко|кога|къде|накъде|откъде|докога|дали|кво|що|нима|нали)(?!\p{L})|как\p{L}+|(?:what|when|where|who|whom|whose|which|how|why|whether)(?:['’]?s)?(?![\p{L}'’])|(?:is|are|was|were|do|does|did|will|would|can|could|should|shall|may|might)\s+(?:you|u|ya|it|there|i|we|they|he|she|this|that)(?!\p{L}))`;
const REQUEST_AT = new RegExp(String.raw`${REQUEST_LEAD}${REQUEST_WORD}`, "iuy");
// After a joiner, a Bulgarian command also by its shape: a small-letter word
// ending in „-и“, „-й“, „-ете“ or „-йте“ with more words after it („…,
// разпечатай ми …“, „… и ми препоръчай вино“), but not a list of things („…,
// ябълки и круши“).
const IMPERATIVE_AT = new RegExp(
  String.raw`(?:(?:${LEAD_WORDS})[\s,]+){0,3}(?:(?:${SHORT_PRONOUNS})\s+){0,2}(?=\p{Ll})\p{L}{2,}(?:и|й|ете|йте)(?=\s+(?!(?:и|или)(?:\s|$))[\p{L}\p{N}])`,
  "uy",
);
// After a comma, „;“ or „:“ a helping verb asks a question whatever follows
// it („…, is amoxicillin ok“, „…, are eggs ok“, „…, does butter have …“).
const QUESTION_AFTER_COMMA =
  /(?:is|are|was|were|do|does|did|will|would|can|could|should|shall|may|might)\s+\p{L}/iuy;
// Where a new clause can start: after a comma, „;“, „:“, a bracket, a slash,
// a period, a dash or a joining word. Two joiners in a row both count („… и
// след това провери …“, „…, след това …“).
const CLAUSE_JOINER =
  /(?:[,;:(/.]|(?<=\s)-{1,2}|-{2,})\s*|(?<=\s)(?:и|а|но|ама|обаче|или|после|след\s+това|след\s+което|затова|пък|освен\s+това|също|плс|моля|and|then|but|or|plus|also|so|btw|pls|plz|please|by\s+the\s+way|anyway)\s+/giu;
// „… ли …“ asks a question („ще вали ли утре“, „можеш ли“).
const QUESTION_PARTICLE = /(?:^|[^\p{L}])ли(?=[^\p{L}]|$)/iu;

function requestStartsAt(text, index, { shape = false } = {}) {
  REQUEST_AT.lastIndex = index;
  if (REQUEST_AT.test(text)) return true;
  if (!shape) return false;
  IMPERATIVE_AT.lastIndex = index;
  return IMPERATIVE_AT.test(text);
}

// The same at any word, not only at the start of a clause (fifth review of
// #605): a request glued to the fact with no comma („… в 10 напомни ми
// довечера“, „… 18 ч pls напомни ми“, „… и я прати на Иван“) still keeps the
// one-time confirmation. Bulgarian commands count in their exact forms, so
// „проверката“, „купих“ or „кратки отговори“ in a fact do not. A one-off
// command counts anywhere; a standing one („пиши ми на ти“, „казвай ми
// всичко“, „отговаряй ми кратко“) opening the fact is a preference to keep,
// and counts only further on.
const BG_ONE_OFF_STEMS = String.raw`каж|провер|покаж|изпрат|прат|препрат|прочет|направ|напиш|намер|потърс|пусн|отвор|създа|добав|изтри|напомн|подсет|разкаж|да|обясн|превед|сравн|запиш|запаз|резервира|поръча|куп|плат|звънн|обад|уведом|подготв|изчисл|пресметн|сметн|помогн|погледн|предлож|препоръча|обобщ|слож|върн|спр|махн|включ|изключ|попита|измисл|помисл|събуд|донес|взем|сготв|избер|сподел|продълж|отмен|премест|повтор|избро|отбележ|насроч|подпиш|увелич|намал|настро|свърж|извика|прегледа|информира|организира|планира|разпечата|генерира|нарисува|състав|опиш|анализира|обработ|коригира|редактира|съкрат|разшир|допиш|маркира|архивира|кач|свал|изтегл|прехвърл|оправ|почист|изчист|подред|изпе|изслуша`;
const BG_STANDING_STEMS = String.raw`пиш|чет|пита|казва|праща|обажда|напомня|събужда|подсеща|пи`;
const BG_ONE_OFF_COMMAND = new RegExp(
  String.raw`(?<![\p{L}])(?:(?:${BG_ONE_OFF_STEMS})(?:и|й|ете|йте)|виж|вижте|ела|елате|чуй|чуйте)(?![\p{L}])`,
  "iu",
);
const BG_STANDING_COMMAND = new RegExp(
  String.raw`(?<![\p{L}])(?:${BG_STANDING_STEMS})(?:и|й|ете|йте)(?![\p{L}])`,
  "giu",
);
const SECOND_PERSON_SKIP = String.raw`(?<!недей(?:те)?\s+да\s+(?:(?:${SHORT_PRONOUNS})\s+){0,2})`;
const REQUEST_ANYWHERE = new RegExp(
  [
    // A Bulgarian question word, also after a preposition („от къде“, „по
    // колко“, „с какво“), and „има ли“ typed as one word.
    String.raw`(?<![\p{L}])(?:как|кой|коя|кое|кои|чий|чия|чие|чии|защо|колко|кога|къде|накъде|откъде|докога|дали|какво|какъв|каква|какви|кво|що|нима|нали)(?![\p{L}])`,
    String.raw`(?<![\p{L}])имали(?![\p{L}])(?!\s+(?:сме|са|сте|бяхме|бяха)(?![\p{L}]))`,
    // A verb in the second person speaks to the assistant („можеш да ми
    // напомниш“, „ще ми помогнеш“, „имаш ли“). „Недей да ми звъниш“ is a
    // preference.
    String.raw`(?<![\p{L}])${SECOND_PERSON_SKIP}\p{L}{2,}(?:еш|иш|аш|яш)(?![\p{L}])`,
    // Polite words and asking for ideas or help.
    String.raw`(?<![\p{L}])(?:моля|нека|хайде|айде|плс|можете|бихте|ако\s+може|ако\s+обичаш|ако\s+обичате|не\s+забравяй(?:те)?|да\s+(?:видим|помислим|измислим|проверим|решим|планираме|уточним|направим)|искам\s+да\s+(?:ми|ни)|искам(?:е)?\s+(?:идеи|идея|съвет|съвети|помощ|предложени\p{L}*|препоръ\p{L}*)|трябва(?:т)?\s+(?:ми|ни)\s+(?:идеи|идея|съвет|съвети|помощ|предложени\p{L}*|препоръ\p{L}*)|идеи|предложения|препоръки|съвети)(?![\p{L}])`,
    // English: a question word with „'s“ („what's“, „whats“, „how's“), a
    // question word before a helping verb or „time/much/long“, „can you/u“,
    // „is there any“, „is it ok“, polite words and asking for ideas.
    String.raw`(?<![\p{L}'’])(?:what|how|where|who|when|why)(?:['’]s|s)(?![\p{L}'’])`,
    String.raw`(?<![\p{L}'’])(?:what|how|where|when|who|which|why)\s+(?:is|are|was|were|do|does|did|can|could|should|would|will|time|day|kind|about|much|many|long|far|often|old|come|if|else)(?![\p{L}'’])`,
    String.raw`(?<![\p{L}'’])(?:can|could|would|will|do|did|does|are|were|have|should|shall)\s+(?:you|u|ya)(?![\p{L}'’])`,
    String.raw`(?<![\p{L}'’])(?:is|are)\s+there\s+(?:any|a|an)(?![\p{L}'’])|(?<![\p{L}'’])is\s+it\s+(?:ok|okay|safe|fine|possible|true|bad|good|normal|better|worth|too|really|legal|healthy|smart|necessary|likely|going)(?![\p{L}'’])`,
    String.raw`(?<![\p{L}'’])(?:please|pls|plz|kindly|lmk|let\s+me\s+know|let['’]s|let\s+us|i\s+need\s+you|i\s+want\s+you|i['’]d\s+like|i\s+would\s+like|need\s+you\s+to|want\s+you\s+to|any\s+(?:\p{L}+\s+)?(?:idea|ideas|tips|suggestions|recommendations|thoughts|advice)|ideas|suggestions|recommendations|don['’]?t\s+forget|do\s+not\s+forget|make\s+sure|you\s+(?:should|could|can|need\s+to|have\s+to|must|might\s+want)|feel\s+free|btw|by\s+the\s+way|gimme|lemme|wanna|gonna\s+you|i\s+wonder|wondering|thoughts\s+on|tips\s+for|how\s+about|what\s+about)(?![\p{L}'’])`,
  ].join("|"),
  "iu",
);
// Before a small-letter word ending like a Bulgarian command, „ме/ми/ни“
// shows the command („… подсети ме довечера“): further on in the fact, a
// word that ends like a command and has „me“ right after it is not a fact.
// Adverbs, numbers and plural nouns after a possessive word are not commands
// („винаги ми е студено“, „моите приятели ме наричат Радо“).
const IMPERATIVE_BEFORE_ME =
  /(?<![\p{L}])(?<!(?:моите|твоите|нашите|вашите|техните|неговите|нейните|тези|онези|някои|много|няколко|всички|двама|трима|двете|трите|\d+)\s+)(?!(?:винаги|вкъщи|почти|дори|преди|може|ами|двете|всички|или)(?![\p{L}]))(?=\p{Ll})\p{L}{2,}(?:и|й|ете|йте)\s+(?:ме|ми|ни)(?![\p{L}])/gu;
// Whether a regular expression with the „g“ flag matches past the first word.
function matchesAfter(pattern, text, index) {
  pattern.lastIndex = index;
  return pattern.test(text);
}
// An English request verb counts at any word when an object follows it
// („… tomorrow check my calendar“, „… at 8 remind me at 7“, „… vegan suggest
// a menu“), unless a subject, a helping verb or „to“ comes right before it
// („I check my mail at 9“, „my parents call me on Sundays“, „I want to book
// a trip“). „Call me Rado“ names the person.
const ENGLISH_STATEMENT_BEFORE = String.raw`[Ii]|we|you|they|u|to|not|never|always|usually|often|sometimes|rarely|seldom|also|just|only|really|still|both|all|can|cannot|could|will|would|should|must|might|may|do|does|did|who|that|which|can['’]t|couldn['’]t|won['’]t|wouldn['’]t|shouldn['’]t|don['’]t|doesn['’]t|didn['’]t|dont|doesnt|didnt|cant|wont|[Ii]['’]ll|we['’]ll|you['’]ll|they['’]ll|[Ii]['’]d|we['’]d|you['’]d|they['’]d|people|everyone|everybody|parents|kids|children|friends|colleagues|neighbo(?:u)?rs|twins|grandparents|students|guys|[Ww]e|[Tt]hey|[Yy]ou`;
const ENGLISH_REQUEST_VERBS = String.raw`tell|show|check|send|read|make|write|find|search|look|open|create|add|delete|remove|remind|email|e-mail|text|call|book|buy|order|schedule|set|give|get|list|summari[sz]e|translate|explain|draft|reply|answer|forward|play|start|stop|cancel|update|change|fix|help|compare|calculate|plan|prepare|ask|bring|put|keep|note|save|turn|go|try|see|watch|wake|suggest|recommend|share|print|ping|message|notify|review|research|pick|grab|organi[sz]e|sort|draw|generate|convert|recap|outline|figure|google`;
const ENGLISH_OBJECT = String.raw`me|us|him|her|them|it|my|our|your|his|their|the|a|an|this|that|these|those|some|all|out|up|back|down|off|over|if|whether|what|when|where|how|who|which|whats|what['’]s|everything|something|anything|someone|somebody|\p{Lu}\p{L}*`;
const ENGLISH_REQUEST_ANYWHERE = new RegExp(
  String.raw`(?<![\p{L}\p{N}'’-])(?<!(?:^|[^\p{L}'’])(?:${ENGLISH_STATEMENT_BEFORE})\s+)(?!call\s+me\s+\p{Lu})(?:${ENGLISH_REQUEST_VERBS})\s+(?:${ENGLISH_OBJECT})(?![\p{L}'’])`,
  "u",
);
// Bulgarian typed in Latin letters after a Cyrillic „Запомни:“ („…, kaji mi
// kakvo da sgotvq“, „mojesh li …“).
const LATIN_BULGARIAN_REQUEST =
  /(?<![\p{L}])(?:kaji|kazhi|kazi|kajete|kazhete|napomni|napomnete|pokaji|pokazhi|pokazi|proveri|provei|prati|izprati|napishi|napisi|pishi|nameri|potarsi|potursi|pusni|otvori|dobavi|iztrii|obiasni|obqsni|obyasni|prevedi|sravni|otgovori|zapishi|zapisi|kupi|plati|zvanni|zvunni|obadi|uvedomi|podgotvi|izchisli|presmetni|smetni|pomogni|pogledni|predloji|predlozhi|preporachai|preporuchai|slozhi|sloji|varni|vurni|spri|mahni|vkluchi|vklyuchi|izkluchi|izklyuchi|pitai|popitai|vij|vizh|vijte|vizhte|ela|elate|izmisli|pomisli|sabudi|subudi|donesi|vzemi|sgotvi|podseti|kak|kakvo|kakuv|kakav|kakva|kakvi|koga|kade|kude|kyde|kolko|zashto|zasto|dali|koi|koq|koia|koe|kvo|li|nali|imali|moje|mozhe|mojete|mozhete|molq|molia|mola|hajde|haide|aide|neka|iskam\s+da\s+mi|trqbvat\s+mi|trqbva\s+mi|imash|pls|plz)(?![\p{L}])|(?<![\p{L}])\p{L}{2,}(?:esh|ish|ash|qsh|iash|ysh)(?![\p{L}])/iu;

// A list line: a dash, a bullet or a number („- …“, „• …“, „2. …“).
const LIST_ITEM = /^(?:[-*•]|\d+[.)])\s+\S/u;
// The marks a plain fact uses: Latin or Cyrillic letters, digits 0–9, spaces
// and the punctuation of an ordinary sentence, a name, an address, a date, a
// price or an e-mail. A question mark, „¿“ or „¡“, a smiley, a dash other
// than the hyphen, a star, a zero-width, full-width or look-alike mark, a
// letter of another script, a tab or a line separator keeps the one-time
// confirmation (review of #605): what such a mark hides is never written as
// part of the fact. Only a list of facts on one line uses „;“.
const PLAIN_FACT_TEXT =
  /^(?:(?=[\p{Lu}\p{Ll}\p{Lt}])[\p{sc=Latin}\p{sc=Cyrillic}]|[0-9 ,.:!…'‘’"„“”«»()/@#%&+=№€$£°_-])+$/u;
const PLAIN_LIST_TEXT =
  /^(?:(?=[\p{Lu}\p{Ll}\p{Lt}])[\p{sc=Latin}\p{sc=Cyrillic}]|[0-9 ,.:;!…'‘’"„“”«»()/@#%&+=№€$£°_-])+$/u;
function isPlainText(text, pattern) {
  return pattern.test(String(text || "").normalize("NFC"));
}

// A „but“ clause carries a condition or a request to wait („…, но не още“,
// „…, but not yet“): the person gets the one-time confirmation.
const CONTRAST_CLAUSE =
  /(?:^|[^\p{L}])(?:но|ама|обаче|ала|but|however|although|though|aber|jedoch|pero|sino|mais|cependant|ma|però|tuttavia|dar|însă|insa)(?=[^\p{L}]|$)/iu;
// The command in German, Spanish, French, Italian or Romanian is written at
// once only as one plain clause: no comma, colon, bracket, slash, dash,
// joining word or second sentence („Recuerda: me gusta el té, y dime …“).
const OTHER_LANGUAGE_COMMAND =
  /^(?:merken|merk\s+dir|recordar|recuerda|retenir|retiens|ricorda|ricordare|[țţt]ine\s+minte)(?=[\s:,])/iu;
const OTHER_LANGUAGE_JOINER =
  /[,;:(/]|\s-|-{2}|\.\s+\p{L}|(?:^|\s)(?:y|e|et|und|și|si|and|o|oder|ou|sau|ma|mais|pero|aber|dar|sondern|sino|luego|dann|puis|poi|apoi|también|auch|aussi|anche|und)(?=\s|$)/iu;
// In those languages a request or a question with no comma before it also
// keeps the confirmation (fifth review): a request word or a question word,
// a verb joined to „me/you“ by a hyphen („rappelle-moi“, „amintește-mi“,
// „peux-tu“), a Spanish command with „me“ on it („recuérdamelo“), and more
// than eight words.
const OTHER_LANGUAGE_REQUEST = new RegExp(
  [
    String.raw`kannst|k[öo]nntest|w[üu]rdest|w[üu]rden\s+sie|k[öo]nnen\s+sie|schick\p{L}*|schreib\p{L}*|sag|zeig\p{L}*|erinner\p{L}*|ruf|such|hilf|gib|mach|pr[üu]f\p{L}*|bitte|danke|was|wie|wann|wo|wohin|woher|warum|wieso|weshalb|wer|wen|wem|welche\p{L}*|ob|wieviel|gibt\s+es|empfiehl\p{L}*|empfehlen|vorschlag\p{L}*|schlag\p{L}*|lass\s+uns|lass\s+mich|ideen|tipps`,
    String.raw`puedes|podr[íi]as|podr[íi]a|pod[ée]is|dime|d[íi]melo|dame|d[áa]melo|hazme|m[áa]ndame|env[íi]ame|escr[íi]beme|b[úu]scame|ay[úu]dame|ll[áa]mame|av[íi]same|recu[ée]rdame|recu[ée]rdamelo|recomi[ée]ndame|recomiendas|sugi[ée]reme|sugieres|mu[ée]strame|expl[íi]came|tr[áa]eme|p[íi]deme|por\s+favor|porfa|porfavor|gracias|qué|cómo|cuándo|dónde|adónde|cuál(?:es)?|cuánt[oa]s?|quién(?:es)?|por\s+qué|porqué|necesito\s+que|quiero\s+que|alguna\s+idea|ideas|consejos`,
    String.raw`tu\s+peux|tu\s+pourrais|vous\s+pouvez|vous\s+pourriez|s['’]il\s+te\s+pla[îi]t|s['’]il\s+vous\s+pla[îi]t|stp|svp|merci|quoi|comment|quand|où|pourquoi|quel(?:le)?s?|combien|est-ce\s+que|qu['’]est-ce|j['’]ai\s+besoin\s+que|je\s+veux\s+que|une\s+id[ée]e|des\s+id[ée]es|conseils`,
    String.raw`puoi|potresti|dimmi|dammi|fammi|mandami|scrivimi|ricordami|ricordamelo|ricordatelo|chiamami|aiutami|cercami|trovami|mostrami|consigliami|spiegami|suggeriscimi|dicci|mandaci|aiutaci|portami|prenotami|svegliami|avvisami|consigli|per\s+favore|perfavore|per\s+piacere|grazie|che\s+cosa|cosa|quando|dove|perch[ée]|quale|quali|quant[oaie]|chi|ho\s+bisogno\s+che|voglio\s+che|qualche\s+idea|idee`,
    String.raw`po[țţt]i|pute[țţt]i|ai\s+putea|a[țţt]i\s+putea|recomanzi|te\s+rog|v[ăa]\s+rog|mersi|mul[țţt]umesc|ce|cum|c[âa]nd|unde|de\s+ce|care|c[âa]t|c[âa]t[ăa]|c[âa][țţt]i|c[âa]te|cine|am\s+nevoie\s+s[ăa]|vreau\s+s[ăa]\s+(?:[îi]mi|mi)|vreo\s+idee|idei|sfaturi`,
  ]
    .map((words) => String.raw`(?<![\p{L}])(?:${words})(?![\p{L}])`)
    .concat([
      String.raw`\p{L}-(?:moi|toi|nous|vous|le|la|les|lui|leur|tu|il|elle|on|ils|elles|mi|ne|[țţt]i|m[ăa]|v[ăa])(?![\p{L}])`,
      String.raw`(?<![\p{L}])(?=\p{L}*[áéíóú])\p{L}{2,}(?:me|nos)(?:lo|la|los|las)?(?![\p{L}])`,
    ])
    .join("|"),
  "iu",
);
const OTHER_LANGUAGE_MAX_WORDS = 8;
// A fact longer than this is no plain fact; it gets the confirmation.
const MAX_PLAIN_FACT_WORDS = 25;

// Where a fact starts once list marks and opening quotes are passed („- …“,
// „1) …“, „«…“, „‘…“).
const FACT_START = /^(?:(?:[-*•]|\d+[.)])\s+|[„“”"'‘’«»(\s])*/u;

function isPlainMemoryFact(fact, language = "bg") {
  const words = fact.split(/\s+/u).filter(Boolean).length;
  if (words > MAX_PLAIN_FACT_WORDS) return false;
  const factStart = fact.match(FACT_START)[0].length;
  const secondWord = fact.slice(factStart).search(/(?<=\S)\s/u);
  // No second word: nothing further on to check.
  const afterFirstWord = secondWord < 0 ? fact.length : factStart + secondWord;
  if (
    hasSecondSentence(fact) ||
    NESTED_MEMORY_COMMAND.test(fact) ||
    QUESTION_PARTICLE.test(fact) ||
    requestStartsAt(fact, factStart) ||
    BG_ONE_OFF_COMMAND.test(fact) ||
    REQUEST_ANYWHERE.test(fact) ||
    ENGLISH_REQUEST_ANYWHERE.test(fact) ||
    matchesAfter(BG_STANDING_COMMAND, fact, afterFirstWord) ||
    matchesAfter(IMPERATIVE_BEFORE_ME, fact, afterFirstWord)
  ) {
    return false;
  }
  if (language === "bg" && LATIN_BULGARIAN_REQUEST.test(fact)) return false;
  if (
    language === "other" &&
    (words > OTHER_LANGUAGE_MAX_WORDS || OTHER_LANGUAGE_REQUEST.test(fact))
  ) {
    return false;
  }
  for (const match of fact.matchAll(CLAUSE_JOINER)) {
    const start = match.index + match[0].length;
    if (requestStartsAt(fact, start, { shape: true })) return false;
    if (/^[,;:]/u.test(match[0])) {
      QUESTION_AFTER_COMMA.lastIndex = start;
      if (QUESTION_AFTER_COMMA.test(fact)) return false;
    }
  }
  return true;
}

// Which language the command is in: Bulgarian („Запомни“, „Запази“,
// „Поправка“), English („Remember“) or another of the site's languages.
function memoryCommandLanguage(text) {
  if (OTHER_LANGUAGE_COMMAND.test(text)) return "other";
  if (/^remember(?![\p{L}])/iu.test(text)) return "en";
  return "bg";
}

// The person's own command is their „да“ and is written at once (РАДКО
// 28.11). Only a command that opens the message counts, and only when it
// holds one plain fact, or a list of plain facts. Everything else keeps the
// one-time confirmation and writes nothing: a message that asks to wait or to
// be asked first, a bare „Поправка: …“, a „Запомни:“ inside forwarded or
// pasted text (a Drive summary, a letter), a second command, a question, and
// a command that runs on into another line, sentence or request, so the rest
// of the message is never stored as the fact. What is judged here is exactly
// what the chat writes (extractPersistentMemoryCommands).
export function isOwnMemoryCommand(message) {
  const text =
    typeof message === "string" ? message.replace(/\r\n?/gu, "\n").trim() : "";
  if (!text) return false;
  if (WAIT_FOR_MEMORY_CONFIRMATION.test(text)) return false;
  if (CONTRAST_CLAUSE.test(text)) return false;
  if (BARE_MEMORY_CORRECTION.test(text)) return false;
  const written = extractPersistentMemoryCommands(text);
  if (!written.length) return false;
  let judged;
  const bulk = BULK_MEMORY_PATTERNS.find(({ pattern }) => pattern.test(text));
  if (bulk) {
    // A list is one fact per line (each line a dash, a bullet or a number) or
    // one line split by „;“.
    const body = text.match(bulk.pattern)[1].trim();
    const lines = body
      .split(/\n+/u)
      .map((line) => line.trim())
      .filter(Boolean);
    // A list longer than what is written (30 facts) keeps the confirmation:
    // what would be left out is never dropped silently.
    const parts = lines.length > 1 ? lines : body.split(/;/u).filter((part) => part.trim());
    if (parts.length > MAX_LIST_FACTS) return false;
    if (lines.length > 1) {
      if (!lines.every((line) => LIST_ITEM.test(line))) return false;
      const items = lines.map((line) =>
        line.replace(/^(?:[-*•]|\d+[.)])\s+/u, ""),
      );
      if (!items.every((item) => isPlainText(item, PLAIN_FACT_TEXT))) return false;
    } else if (!isPlainText(body, PLAIN_LIST_TEXT)) {
      return false;
    }
    judged = splitMemoryFacts(body).map((fact) => ({ fact, scope: bulk.scope }));
  } else {
    const single = extractPersistentMemoryCommand(text);
    if (!single) return false;
    const body = text.replace(/^[^\n]*?(?::|,?\s+че\s)\s*/u, "");
    if (!isPlainText(body, PLAIN_FACT_TEXT)) return false;
    if (OTHER_LANGUAGE_COMMAND.test(text) && OTHER_LANGUAGE_JOINER.test(body)) {
      return false;
    }
    judged = [single];
  }
  if (
    judged.length !== written.length ||
    judged.some(
      (item, index) =>
        item.fact !== written[index].fact || item.scope !== written[index].scope,
    )
  ) {
    return false;
  }
  const language = memoryCommandLanguage(text);
  return judged.every(({ fact }) => isPlainMemoryFact(fact, language));
}

export function extractPersistentMemoryCommands(message) {
  const text = message.trim();
  // A proposal is still a memory intent, but it must never write anything by
  // itself. Recognize the explicit "do not write yet" wording so the route can
  // create the same one-time confirmation used by the canonical `Запомни:`
  // command instead of leaving the model to invent a free-form confirmation.
  const proposalCommand = text.match(
    /не\s+записвай\s+нищо\s+още\s*:\s*([\s\S]+?)(?=\.\s*(?:покажи|изчакай)(?:\s|$)|$)/iu,
  );
  if (proposalCommand?.[1]) {
    const fact = cleanMemoryFact(proposalCommand[1]);
    if (fact) return [{ fact, scope: "personal" }];
  }

  const embeddedCommand = text.match(
    /(?:^|[.!?]\s+)(?:накрая\s+)?(?:поискай\s+потвърждение\s+да\s+)?запомни(?:ш)?(?:\s+в\s+постоянната\s+ми\s+памет)?\s*:\s*[„“"'’]?([^„“"'’]+?)[„“"'’]?(?=\s+(?:преди\s+запис|не\s+записвай|не\s+променяй)|$)/iu,
  );
  if (embeddedCommand?.[1]) {
    const fact = cleanMemoryFact(embeddedCommand[1]);
    if (fact) return [{ fact, scope: "personal" }];
  }

  for (const { scope, pattern } of BULK_MEMORY_PATTERNS) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return splitMemoryFacts(match[1]).map((fact) => ({ fact, scope }));
    }
  }

  const singleCommand = extractPersistentMemoryCommand(text);
  return singleCommand ? [singleCommand] : [];
}

export function extractForgetMemoryCommand(message) {
  const text = message.trim();
  const projectPatterns = [
    /^(?:забрави|изтрий)\s+за\s+проекта\s*:\s*(.+)$/iu,
    /^(?:забрави|изтрий)\s+за\s+проекта\s*,?\s+че\s+(.+)$/iu,
  ];
  const personalPatterns = [
    /^(?:забрави|изтрий)(?:\s+от\s+(?:постоянната\s+)?памет(?:та)?)?(?:\s+само)?(?:\s+(?:на\s+)?факта)?\s*,?\s+че\s+(.+)$/iu,
    /^(?:забрави|изтрий)(?:\s+от\s+(?:постоянната\s+)?памет(?:та)?)?(?:\s+само)?(?:\s+(?:на\s+)?факта)?\s*:\s*(.+)$/iu,
  ];

  for (const pattern of projectPatterns) {
    const match = text.match(pattern);
    const fact = match?.[1] ? cleanMemoryFact(match[1]) : "";
    if (fact) return { fact, scope: "project" };
  }
  for (const pattern of personalPatterns) {
    const match = text.match(pattern);
    const fact = match?.[1] ? cleanMemoryFact(match[1]) : "";
    if (fact) return { fact, scope: "personal" };
  }
  return null;
}

export function isForgetAllCommand(message) {
  return /^(?:забрави|изтрий)\s+(?:цялата|всичко\s+от)\s+постоянна(?:та)?\s+(?:ми\s+)?памет[.!]?$/iu.test(
    message.trim(),
  );
}

export function isConfirmedForgetAllCommand(message) {
  return /^потвърждавам\s+изтриването\s+на\s+цялата\s+постоянна\s+(?:ми\s+)?памет[.!]?$/iu.test(
    message.trim(),
  );
}

async function fetchProfileHits(ownerId = OWNER_ID) {
  const documents = await getFirestoreStoreOrThrow().listProfileDocuments(
    ownerId,
    MAX_MEMORIES,
  );
  return documents
    .sort((a, b) =>
      String(b.data?.updatedAt || "").localeCompare(
        String(a.data?.updatedAt || ""),
      ),
    )
    .map((document) => ({ _id: document.id, _source: document.data }));
}

function hydrateMemory(hit) {
  if (!hit?._source?.fact) return null;
  const inferred = deriveMemoryMetadata(
    hit._source.fact,
    hit._source.scope || "personal",
  );
  return {
    id: hit._id,
    ...hit._source,
    storedMemoryKey: hit._source.memoryKey || null,
    // Always infer with the current rules. This makes old value-included keys
    // compatible with the new topic keys without deleting or rebuilding the
    // production index.
    memoryKey: inferred.memoryKey,
    category: inferred.category,
    scope: hit._source.scope || inferred.scope,
  };
}

function expandLegacyMemory(memory) {
  const fact = cleanMemoryFact(memory.fact || "");
  if (!fact) return [];

  const bulletParts = fact
    .replace(/^\s*-\s*/u, "")
    .split(/\s+-\s+(?=[А-ЯA-Z])/u);
  const facts = bulletParts.flatMap((part) =>
    part.split(
      /\s+и\s+(?=(?:аз\s+)?(?:се\s+интересувам|живея|имам\s+(?:бизнес|фирма|магазин|заведение|бунгала|къмпинг)|казвам\s+се))/iu,
    ),
  );

  return facts
    .map(cleanMemoryFact)
    .filter(Boolean)
    .map((itemFact) => {
      const inferred = deriveMemoryMetadata(
        itemFact,
        memory.scope || "personal",
      );
      return {
        ...memory,
        fact: itemFact,
        normalizedFact: normalizeFact(itemFact),
        ...inferred,
      };
    });
}

export function consolidateMemoryView(memories) {
  const expanded = memories.flatMap(expandLegacyMemory);
  const seenKeys = new Set();
  const unique = [];

  for (const memory of expanded) {
    if (seenKeys.has(memory.memoryKey)) continue;
    seenKeys.add(memory.memoryKey);
    unique.push(memory);
  }

  const interestItems = unique.filter(
    (memory) => memory.category === "interest",
  );
  if (interestItems.length < 2) return unique;

  const seen = new Set();
  const interests = [];
  for (const memory of interestItems) {
    const value = cleanMemoryFact(memory.fact).replace(
      /^(?:(?:аз\s+)?се\s+интересувам|интересувам\s+се)\s+от\s+/iu,
      "",
    );
    for (const item of value.split(/\s*(?:,|;|\s+и\s+)\s*/iu)) {
      const cleanItem = item.trim();
      const key = normalizeFact(cleanItem);
      if (!cleanItem || seen.has(key)) continue;
      seen.add(key);
      interests.push(cleanItem);
    }
  }

  const newestInterest = interestItems[0];
  const consolidated = {
    ...newestInterest,
    fact: `Интересувам се от ${interests.join(", ")}`,
    normalizedFact: normalizeFact(interests.join(", ")),
    memoryKey: "personal:interest:summary",
    category: "interest",
  };
  const firstInterestIndex = unique.findIndex(
    (memory) => memory.category === "interest",
  );

  return unique
    .filter((memory) => memory.category !== "interest")
    .toSpliced(firstInterestIndex, 0, consolidated);
}

export async function listProfileMemories(options = {}) {
  const requestedScope = typeof options === "string" ? options : options?.scope;
  const ownerId = (typeof options === "object" && options?.ownerId) || OWNER_ID;
  const hits = await fetchProfileHits(ownerId);
  const seenKeys = new Set();
  const memories = [];

  for (const hit of hits) {
    const memory = hydrateMemory(hit);
    if (!memory) continue;
    if (requestedScope && memory.scope !== requestedScope) continue;
    if (seenKeys.has(memory.memoryKey)) continue;
    seenKeys.add(memory.memoryKey);
    memories.push(memory);
  }
  const consolidated = consolidateMemoryView(memories);
  if (requestedScope === "personal") return consolidated;
  // The NovariumAI product definition is the owner's project context only;
  // customer accounts never see it as their own memory.
  if (ownerId !== OWNER_ID) {
    return requestedScope === "project"
      ? consolidated.filter((memory) => memory.scope === "project")
      : consolidated;
  }

  const currentProjectMemories = consolidated.filter(
    (memory) =>
      memory.scope !== "project" ||
      (!isSupersededProjectDefinition(memory.fact) &&
        memory.memoryKey !== "project:identity:definition" &&
        normalizeFact(memory.fact) !== normalizeFact(PROJECT_DEFINITION)),
  );
  const canonicalProjectMemory = {
    id: CANONICAL_PROJECT_MEMORY_ID,
    fact: PROJECT_DEFINITION,
    normalizedFact: normalizeFact(PROJECT_DEFINITION),
    memoryKey: "project:identity:definition",
    category: "identity",
    scope: "project",
    source: "system-canonical",
    readOnly: true,
  };

  if (requestedScope === "project") {
    return [canonicalProjectMemory, ...currentProjectMemories];
  }

  const firstProjectIndex = currentProjectMemories.findIndex(
    (memory) => memory.scope === "project",
  );
  if (firstProjectIndex < 0) {
    return [...currentProjectMemories, canonicalProjectMemory];
  }
  return currentProjectMemories.toSpliced(
    firstProjectIndex,
    0,
    canonicalProjectMemory,
  );
}

export async function saveProfileMemory(
  fact,
  source = "explicit-chat-command",
  requestedScope = "personal",
  ownerId = OWNER_ID,
) {
  const { fact: cleanFact, scope } = normalizeProfileMemoryDraft(
    fact,
    requestedScope,
  );

  const normalizedFact = normalizeFact(cleanFact);
  const metadata = deriveMemoryMetadata(cleanFact, scope);
  const hits = await fetchProfileHits(ownerId);
  const hydrated = hits.map(hydrateMemory).filter(Boolean);
  const sameTopic = hydrated.filter(
    (memory) => memory.memoryKey === metadata.memoryKey,
  );
  const exact = sameTopic.find(
    (memory) =>
      (memory.normalizedFact || normalizeFact(memory.fact)) === normalizedFact,
  );
  const existing = exact || sameTopic[0];
  const id = profileMemoryDocumentId(ownerId, metadata.memoryKey);
  const now = new Date().toISOString();

  const duplicateIds = sameTopic
    .filter((memory) => memory.id !== id)
    .map((memory) => memory.id);

  const document = {
    ownerId,
    fact: cleanFact,
    normalizedFact,
    ...metadata,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    source,
  };

  await getFirestoreStoreOrThrow().commitProfileDocument({
    id,
    data: document,
    deleteIds: duplicateIds,
  });
  // A replace takes the old shared line out; only the same words in other
  // capitals keep it (the person shares a new fact themselves).
  await announceMemoryChange(
    ownerId,
    sameTopic
      .filter((memory) => normalizeFact(memory.fact || "") === normalizedFact)
      .flatMap((memory) => renamedPairs(memory.fact, cleanFact)),
  );

  return {
    id,
    fact: cleanFact,
    normalizedFact,
    ...metadata,
    updatedAt: now,
    source,
    cleanupCompleted: true,
    replaced: Boolean(
      existing &&
      (existing.normalizedFact || normalizeFact(existing.fact)) !==
        normalizedFact,
    ),
  };
}

export async function updateProfileMemoryById(
  id,
  fact,
  requestedScope = "personal",
  ownerId = OWNER_ID,
) {
  const cleanId = typeof id === "string" ? id.trim() : "";
  if (!cleanId || cleanId.length > 200) {
    const error = new Error("Невалиден идентификатор на спомен.");
    error.code = "INVALID_MEMORY";
    throw error;
  }
  const { fact: cleanFact, scope } = normalizeProfileMemoryDraft(
    fact,
    requestedScope,
  );
  const existing = (
    await getFirestoreStoreOrThrow().getProfileDocument(cleanId)
  )?.data;
  if (!existing) {
    const missing = new Error("Споменът не е намерен.");
    missing.code = "MEMORY_NOT_FOUND";
    missing.status = 404;
    throw missing;
  }
  if (existing?.ownerId !== ownerId) {
    const missing = new Error("Споменът не е намерен.");
    missing.code = "MEMORY_NOT_FOUND";
    missing.status = 404;
    throw missing;
  }

  const normalizedFact = normalizeFact(cleanFact);
  const metadata = deriveMemoryMetadata(cleanFact, scope);
  const nextId = profileMemoryDocumentId(ownerId, metadata.memoryKey);
  const now = new Date().toISOString();
  const body = {
    ownerId,
    fact: cleanFact,
    normalizedFact,
    ...metadata,
    createdAt: existing.createdAt || now,
    updatedAt: now,
    source: "confirmed-memory-update",
  };
  await getFirestoreStoreOrThrow().commitProfileDocument({
    id: nextId,
    data: body,
    deleteIds: nextId === cleanId ? [] : [cleanId],
  });
  // A correction that changes the words, in the panel or through the
  // connector, takes a shared line out: the new words reach visitors only
  // when the person shares them (third review of #605). The same words in
  // other capitals keep it. A memory the edit overwrote (another one with the
  // new words' topic) is gone, so its line leaves too.
  await announceMemoryChange(
    ownerId,
    normalizeFact(existing.fact || "") === normalizedFact
      ? renamedPairs(existing.fact, cleanFact)
      : [],
  );
  return {
    id: nextId,
    fact: cleanFact,
    normalizedFact,
    ...metadata,
    updatedAt: now,
    source: body.source,
    replaced: true,
  };
}

export async function deleteProfileMemoryByFact(
  fact,
  requestedScope = "personal",
  ownerId = OWNER_ID,
) {
  const cleanFact = cleanMemoryFact(fact);
  if (!cleanFact) return 0;

  const metadata = deriveMemoryMetadata(cleanFact, requestedScope);
  const normalizedFact = normalizeFact(cleanFact);
  const hits = await fetchProfileHits(ownerId);
  const matching = hits
    .map(hydrateMemory)
    .filter(
      (memory) =>
        memory?.memoryKey === metadata.memoryKey &&
        (memory.normalizedFact || normalizeFact(memory.fact)) ===
          normalizedFact,
    );
  if (!matching.length) return 0;

  await getFirestoreStoreOrThrow().deleteProfileDocuments(
    matching.map((memory) => memory.id),
  );
  await announceMemoryChange(ownerId);
  return matching.length;
}

export async function deleteProfileMemory(id, ownerId = OWNER_ID) {
  const document = await getFirestoreStoreOrThrow().getProfileDocument(id);
  if (!document || document.data?.ownerId !== ownerId) return false;
  await getFirestoreStoreOrThrow().deleteProfileDocuments([id]);
  await announceMemoryChange(ownerId);
  return true;
}

export async function clearProfileMemories(scope, ownerId = OWNER_ID) {
  const hits = await fetchProfileHits(ownerId);
  const cleared = hits.filter(
    (hit) => !VALID_SCOPES.has(scope) || hit._source?.scope === scope,
  );
  if (!cleared.length) return 0;
  await getFirestoreStoreOrThrow().deleteProfileDocuments(
    cleared.map((hit) => hit._id),
  );
  await announceMemoryChange(ownerId);
  return cleared.length;
}

export async function listConversationMessages(
  sessionId,
  limit = MAX_CONVERSATION_MESSAGES,
  ownerId = OWNER_ID,
) {
  const safeLimit = Math.min(Math.max(limit, 1), MAX_CONVERSATION_MESSAGES);
  const documents =
    await getFirestoreStoreOrThrow().listConversationSessionDocuments(
      ownerId,
      sessionId,
      safeLimit,
    );
  return documents
    .sort((a, b) =>
      String(a.data?.createdAt || "").localeCompare(
        String(b.data?.createdAt || ""),
      ),
    )
    .slice(-safeLimit)
    .map((document) => ({ id: document.id, ...document.data }));
}

export async function listAllConversationMessages(ownerId = OWNER_ID) {
  const documents =
    await getFirestoreStoreOrThrow().listConversationDocuments(ownerId);
  return documents.map((document) => ({ id: document.id, ...document.data }));
}

export async function deleteAllConversations(ownerId = OWNER_ID) {
  const store = getFirestoreStoreOrThrow();
  let deleted = 0;
  for (;;) {
    const documents = await store.listConversationDocuments(ownerId);
    if (!documents.length) return deleted;
    await store.deleteConversationDocuments(documents.map(({ id }) => id));
    deleted += documents.length;
  }
}

export function conversationTitleFromMessages(messages) {
  const firstUserMessage = messages.find(
    (message) =>
      message?.role === "user" && typeof message.content === "string",
  );
  const title = firstUserMessage?.content?.trim().replace(/\s+/g, " ");
  if (!title) return "Нов разговор";
  return title.length > 52 ? `${title.slice(0, 49).trimEnd()}…` : title;
}

export async function listConversationSummaries(
  limit = MAX_CONVERSATIONS,
  ownerId = OWNER_ID,
) {
  const documents =
    await getFirestoreStoreOrThrow().listConversationDocuments(ownerId);
  const grouped = new Map();
  for (const document of documents) {
    const sessionId = document.data?.sessionId;
    if (!sessionId) continue;
    if (!grouped.has(sessionId)) grouped.set(sessionId, []);
    grouped.get(sessionId).push(document.data);
  }
  return [...grouped.entries()]
    .map(([sessionId, messages]) => {
      messages.sort((a, b) =>
        String(a.createdAt || "").localeCompare(String(b.createdAt || "")),
      );
      return {
        sessionId,
        title: conversationTitleFromMessages(messages),
        updatedAt: messages.at(-1)?.createdAt || null,
        messageCount: messages.length,
      };
    })
    .sort((a, b) =>
      String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")),
    )
    .slice(0, Math.min(Math.max(limit, 1), MAX_CONVERSATIONS));
}

export async function saveConversationTurn(
  sessionId,
  userText,
  replyText,
  ownerId = OWNER_ID,
) {
  const timestamp = Date.now();
  const documents = [
    {
      id: randomUUID(),
      data: {
        ownerId,
        sessionId,
        role: "user",
        content: userText,
        createdAt: new Date(timestamp).toISOString(),
      },
    },
    {
      id: randomUUID(),
      data: {
        ownerId,
        sessionId,
        role: "assistant",
        content: replyText,
        createdAt: new Date(timestamp + 1).toISOString(),
      },
    },
  ];
  await getFirestoreStoreOrThrow().commitConversationDocuments(documents);
}

export const MAX_IMPORTED_CONVERSATION_MESSAGES = 50;
export const MAX_IMPORTED_MESSAGE_LENGTH = 12000;
const IMPORTED_CONVERSATION_SOURCES = Object.freeze([
  "claude",
  "chatgpt",
  "other",
]);
const IMPORTED_SESSION_PATTERN =
  /^(claude|chatgpt|other)-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;

export function isImportedConversationSessionId(sessionId, source) {
  const match = IMPORTED_SESSION_PATTERN.exec(String(sessionId || ""));
  return Boolean(match) && (!source || match[1] === source);
}

function conversationImportError(message) {
  return Object.assign(new Error(message), {
    code: "CONVERSATION_IMPORT_INVALID",
    status: 400,
  });
}

// Saves a conversation held in another AI client (for example Claude) as an
// NovariumAI thread for the same owner. A new thread gets a "<source>-<uuid>"
// id; an existing imported thread of the same source can be extended.
export async function saveImportedConversation(
  { source = "claude", sessionId, messages } = {},
  ownerId = OWNER_ID,
  { now = Date.now } = {},
) {
  if (!IMPORTED_CONVERSATION_SOURCES.includes(source)) {
    throw conversationImportError("Непознат източник на разговора.");
  }
  if (
    sessionId !== undefined &&
    !isImportedConversationSessionId(sessionId, source)
  ) {
    throw conversationImportError(
      "Може да се продължи само разговор, запазен от същия източник.",
    );
  }
  if (
    !Array.isArray(messages) ||
    messages.length < 1 ||
    messages.length > MAX_IMPORTED_CONVERSATION_MESSAGES
  ) {
    throw conversationImportError(
      `Изпрати от 1 до ${MAX_IMPORTED_CONVERSATION_MESSAGES} съобщения.`,
    );
  }
  const cleaned = messages.map((message) => {
    const role = message?.role;
    const content =
      typeof message?.content === "string" ? message.content.trim() : "";
    if (
      !["user", "assistant"].includes(role) ||
      !content ||
      content.length > MAX_IMPORTED_MESSAGE_LENGTH
    ) {
      throw conversationImportError(
        `Всяко съобщение има роля user или assistant и текст до ${MAX_IMPORTED_MESSAGE_LENGTH} знака.`,
      );
    }
    return { role, content };
  });
  const targetSessionId = sessionId || `${source}-${randomUUID()}`;
  const timestamp = now();
  const documents = cleaned.map((message, index) => ({
    id: randomUUID(),
    data: {
      ownerId,
      sessionId: targetSessionId,
      role: message.role,
      content: message.content,
      source,
      createdAt: new Date(timestamp + index).toISOString(),
    },
  }));
  await getFirestoreStoreOrThrow().commitConversationDocuments(documents);
  return {
    sessionId: targetSessionId,
    source,
    saved: documents.length,
    appended: Boolean(sessionId),
  };
}

export function buildMemoryContext(
  memories,
  { personName = "Радко", includeProjectIdentity = true } = {},
) {
  const personal = memories.filter(
    (memory) => (memory.scope || "personal") === "personal",
  );
  const storedProject = memories.filter(
    (memory) =>
      memory.scope === "project" && !isSupersededProjectDefinition(memory.fact),
  );
  const hasStoredDefinition = storedProject.some(
    (memory) =>
      normalizeFact(memory.fact) === normalizeFact(PROJECT_DEFINITION),
  );
  const project =
    !includeProjectIdentity || hasStoredDefinition
      ? storedProject
      : [
          {
            id: CANONICAL_PROJECT_MEMORY_ID,
            fact: PROJECT_DEFINITION,
            scope: "project",
            readOnly: true,
          },
          ...storedProject,
        ];
  const format = (items, emptyText) =>
    items.length
      ? items.map((item, index) => `${index + 1}. ${item.fact}`).join("\n")
      : emptyText;

  return [
    "[ПРОВЕРЕНА ПОСТОЯННА ПАМЕТ]",
    `[ЛИЧЕН ПРОФИЛ НА ${personName.toLocaleUpperCase("bg-BG")}]`,
    `Тези факти описват ${personName} — човека. Те не описват теб.`,
    format(personal, "Няма допълнително записани лични факти."),
    "[КОНТЕКСТ НА ПРОЕКТА]",
    `Тези факти описват проекта, а не личността на ${personName}.`,
    format(project, "Няма допълнително записани проектни факти."),
    "Използвай само фактите, които са БУКВАЛНО свързани с текущия въпрос.",
    "При противоречие използвай най-новия показан факт (с по-нисък номер — той е по-нов).",
    "Не смесвай различни записи: 'тестова дума', 'тестов код', 'тестово число' и подобни са РАЗЛИЧНИ факти — не ги заменяй един с друг.",
    "Ако точен запис за зададения въпрос липсва в паметта, отговори честно: 'Не знам' — не измисляй и не предполагай стойност от друг несвързан запис.",
    "Не твърди, че помниш факт, ако не е показан тук или в историята на разговора.",
    "[КРАЙ НА ПАМЕТТА]",
  ].join("\n");
}
