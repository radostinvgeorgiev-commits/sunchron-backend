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
// have now, so a shared line whose memory is gone leaves the visitors' text.
// `renamed` names the words that moved: the panel's own correction, or the
// same words in other capitals.
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

// Every text a memory of this person has now: as stored, and as the memory
// panel shows and shares it (a split or a joined card).
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
  for (const memory of consolidateMemoryView(memories)) texts.add(memory.fact);
  return [...texts];
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
    30,
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
  for (const match of text.matchAll(/[.!?…]+/gu)) {
    const end = match.index + match[0].length;
    const after = text.slice(end);
    const gap = after.match(/^\s*/u)[0];
    const next = after.slice(gap.length).replace(/^[„“"'’«»(\[]+/u, "")[0];
    // The end of the fact, or only closing marks or a smiley after it.
    if (!next || !/[\p{L}\p{N}]/u.test(next)) continue;
    if (match[0] !== ".") return true;
    const before = text.slice(0, end);
    if (!gap) {
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
// A request joined to the fact („…, и ми кажи какво е времето утре“).
const REQUEST_IN_FACT = new RegExp(
  String.raw`(?:[,;]\s*|\s+(?:и|а|но|после|след\s+това|and|then|but)\s+)(?:(?:и|а|но|после|and|then|but)\s+)?(?:(?:ми|ни|me|us)\s+)?(?:кажи|провери|покажи|изпрати|прати|прочети|направи|напиши|намери|потърси|търси|пусни|отвори|създай|добави|изтрий|tell|show|check|send|read|make|write|find|search|open|create|add|delete)(?=[\s,.!?]|$)`,
  "iu",
);
// A list line: a dash, a bullet or a number („- …“, „• …“, „2. …“).
const LIST_ITEM = /^(?:[-*•]|\d+[.)])\s+\S/u;

function isPlainMemoryFact(fact) {
  return (
    !hasSecondSentence(fact) &&
    !NESTED_MEMORY_COMMAND.test(fact) &&
    !REQUEST_IN_FACT.test(fact)
  );
}

// The person's own command is their „да“ and is written at once (РАДКО
// 28.11). Only a command that opens the message counts, and only when it
// holds one plain fact, or a list of plain facts. Everything else keeps the
// one-time confirmation and writes nothing: a message that asks to wait or to
// be asked first, a bare „Поправка: …“, a „Запомни:“ inside forwarded or
// pasted text (a Drive summary, a letter), a second command, and a command
// that runs on into another line, sentence or request, so the rest of the
// message is never stored as the fact. What is judged here is exactly what
// the chat writes (extractPersistentMemoryCommands).
export function isOwnMemoryCommand(message) {
  const text =
    typeof message === "string" ? message.replace(/\r\n?/gu, "\n").trim() : "";
  if (!text) return false;
  if (WAIT_FOR_MEMORY_CONFIRMATION.test(text)) return false;
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
    if (lines.length > 1 && !lines.every((line) => LIST_ITEM.test(line))) {
      return false;
    }
    judged = splitMemoryFacts(body).map((fact) => ({ fact, scope: bulk.scope }));
  } else {
    const single = extractPersistentMemoryCommand(text);
    if (!single) return false;
    const body = text.replace(/^[^\n]*?(?::|,?\s+че\s)\s*/u, "");
    if (body.includes("\n")) return false;
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
  return judged.every(({ fact }) => isPlainMemoryFact(fact));
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
  // The panel's own correction moves a shared line to the new words. A memory
  // the edit overwrote (another one with the new words' topic) is gone, so its
  // line leaves the visitors' text.
  await announceMemoryChange(ownerId, renamedPairs(existing.fact, cleanFact));
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
