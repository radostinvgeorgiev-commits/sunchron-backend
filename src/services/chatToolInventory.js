import {
  isMemoryBackendConfigured,
  isPersistenceBackendConfigured,
  resolveMemoryBackend,
  resolvePersistenceBackend,
} from "../config/memoryBackend.js";
import { useEnglishReplyFallback } from "../config/replyLanguage.js";
import {
  getToolRuntimeAvailability,
  resolveCapability,
} from "../tools/capabilityEngine.js";
import { mediaAvailability } from "./chatMediaProposals.js";
import { GOOGLE_MEMBER_SCOPES } from "./googleDriveService.js";
import { filterCapabilityRequestsForIdentity } from "./memberCapabilityPolicy.js";

// "[ТВОИТЕ ИНСТРУМЕНТИ СЕГА]": the tools this account can use right now, in
// plain words, so the chat model names them truthfully. Without it the model
// was never told which tools it has and honestly said it had none (27.11.2026,
// 22:21). Every status comes from the checks the chat already makes before a
// tool runs: this account's role and the member policy, the registry and its
// permission policy (resolveCapability), the site's settings
// (getToolRuntimeAvailability), and this account's own Google and GitHub
// connections as the chat route read them. Nothing here calls Google, GitHub
// or a model.

export const TOOL_INVENTORY_HEADING = "[ТВОИТЕ ИНСТРУМЕНТИ СЕГА]";
// Room for every example of the longest list (the owner's, review r6: the
// second Google steps and „Моите задачи“ made it longer than 1,200; the exact
// words for an email, a contact and an event made it longer than 1,500).
export const MAX_TOOL_INVENTORY_LENGTH = 1800;

const scope = (name) => `https://www.googleapis.com/auth/${name}`;
const FULL_MAIL = "https://mail.google.com/";
// The scopes each Google service answers to; any one of them is enough.
const GOOGLE_NEEDS = Object.freeze({
  calendar: ["calendar", "calendar.events", "calendar.readonly", "calendar.events.readonly"].map(scope),
  calendarWrite: ["calendar", "calendar.events"].map(scope),
  contacts: ["contacts", "contacts.readonly"].map(scope),
  contactsWrite: [scope("contacts")],
  mailRead: [...["gmail.readonly", "gmail.modify"].map(scope), FULL_MAIL],
  mailSend: [...["gmail.send", "gmail.compose", "gmail.modify"].map(scope), FULL_MAIL],
  drive: ["drive", "drive.readonly"].map(scope),
  youtube: ["youtube", "youtube.readonly", "youtube.force-ssl"].map(scope),
});

// What the model may quote. Each example is a request the chat runs as it is
// written (tests/chatToolInventory.test.js checks each one against the tool
// detector); each button is the one the page or the answer shows.
const TEXT = {
  bg: {
    checked: "Проверени при тази заявка: настройки на сайта и връзките на този акаунт.",
    ready: "Работят:",
    none: "Работят: нито един сега.",
    connect: "Искат свързване:",
    // „Разкачи“ in „Инструменти“ (toolSwitchService.js): the person's own
    // choice, turned back on with „Свържи“ there.
    unplugged: "Разкачени от човека (пуска ги с „Свържи“ в „Инструменти“):",
    // The switches could not be read: the tools are left out for this
    // answer, and that is not the person's choice.
    unavailable: "Спрени само за този отговор (превключвателите в „Инструменти“ не се прочетоха; след малко пак работят):",
    rules: [
      "Питат ли какво можеш, изброй работещите с пример, после чакащите свързване.",
      // Only while some tool works: with none ready it would push against
      // the true answer (review r6). A yes runs a read; a record or a send
      // runs only from the person's own exact words (review r6: „да“ to
      // „Запомни: …“ did nothing).
      "Системата пуска инструмента преди отговора ти; резултатът идва в [РЕЗУЛТАТИ ОТ ИНСТРУМЕНТИ]. Без него кажи кой става и точните думи или ги дай в „Следва:“ („да“ пуска четене, а имейл, контакт или събитие с всички данни подготвя за бутона „Потвърди“). Не казвай, че нямаш инструменти.",
    ],
    // The last rule, with what this account can write.
    confirm: (writes) =>
      `Резултати — само от тази заявка; ${writes ? `записи (${writes}), ` : ""}изпращане и публикуване — само с точното потвърждение.`,
    tools: {
      calendar: ["Календар", "„Програмата ми за утре“"],
      calendarBoth: ["Календар", "„Програмата ми за утре“; „Създай събитие: заглавие | ГГГГ-ММ-ДД ЧЧ:ММ | минути“"],
      calendarWrite: "събития",
      contacts: ["Контакти", "„Намери в контактите Иван“"],
      contactsBoth: ["Контакти", "„Намери в контактите Иван“; „Добави контакт: име | имейл | телефон“"],
      contactsWrite: "контакти",
      gmail: ["Gmail", "„Покажи писмата в Gmail“"],
      gmailBoth: ["Gmail", "„Покажи писмата в Gmail“; „Изпрати имейл до адрес | тема | текст“ (до мен — до теб)"],
      gmailSend: ["Gmail", "„Изпрати имейл до адрес | тема | текст“ (до мен — до теб)"],
      gmailSendOnly: ["Gmail (изпращане)"],
      gmailRead: ["Gmail писма"],
      mailSend: "имейли",
      drive: ["Google Drive", "„Покажи Google Drive“; бутон „Запази в Google“"],
      driveSave: ["Google Drive", "бутон „Запази в Google“"],
      driveSaveOnly: ["Google Drive (запазване)"],
      driveRead: ["Drive файлове"],
      youtube: ["YouTube канал", "„Покажи моя YouTube канал“"],
      youtubeVideo: ["YouTube видео", "резюме по линк"],
      places: ["Карти", "„Намери кафене наблизо“"],
      web: ["Интернет", "„Потърси в интернет …“"],
      media: {
        both: ["Картинки и видео", "опиши ги; „да“ ги прави"],
        images: ["Картинки", "опиши ги; „да“ ги прави"],
        video: ["Видео", "опиши го; „да“ го прави"],
      },
      // „Моите задачи“ is the person's own list, read and added to in their
      // words; the owner's work drafts keep their own words (item 3, fix 4).
      tasks: ["Работни задачи", "„Покажи работните задачи“"],
      todos: ["Моите задачи", "„Моите задачи“; „Добави задача да се обадя на банката утре“"],
      memory: ["Памет", "„Запомни: …“"],
      memoryWrite: "памет",
      files: ["Моите файлове", "питай за качен файл"],
      claude: ["Работа с Claude", "в „Добавки“"],
      github: ["GitHub", "„Последният commit в GitHub“"],
      githubWrite: ["Промени в GitHub"],
      codeWrite: "GitHub",
      cloud: ["Google Cloud", "„Провери Google Cloud“"],
      cloudWrite: "Google Cloud",
    },
    press: {
      google: "„Свържи Google“",
      googleAgain: "„Свържи Google отново“",
      gmail: "„Разреши Gmail“",
      drive: "„Разреши Google Drive“",
      youtube: "„Свържи YouTube“",
      github: "„Свържи GitHub“",
    },
    // The words whose answer shows a second Google step's button, and where
    // that button is (review r6: the list named buttons nobody could find).
    asks: {
      gmail: "„Покажи писмата в Gmail“",
      drive: "„Покажи Google Drive“",
      youtube: "„Покажи моя YouTube канал“",
    },
    inAnswer: (ask, button) => `${ask}, после ${button} в отговора`,
    afterGoogle: (google, ask, button) => `${google}, после ${ask} и ${button} в отговора`,
  },
  en: {
    checked: "Checked at this request: site settings and this account's connections.",
    ready: "Working:",
    none: "Working: none right now.",
    connect: "Need connecting:",
    unplugged: "Turned off by the person (“Connect” in “Tools” turns them on):",
    unavailable: "Paused for this answer only (the switches in “Tools” could not be read; they work again shortly):",
    rules: [
      "Asked what you can do: the working tools with an example, then those to connect.",
      "The system runs tools before your answer; results come in [TOOL RESULTS]. Without one, name the fitting tool and its exact words, or put them in “Next:” (“yes” runs a read, and prepares an email, contact or event with all its fields for the “Confirm” button). Never say you have no tools.",
    ],
    confirm: (writes) =>
      `Results only from this request; ${writes ? `writes (${writes}), ` : ""}sending and publishing only with the exact confirmation.`,
    tools: {
      calendar: ["Calendar", "“My calendar tomorrow”"],
      calendarBoth: ["Calendar", "“My calendar tomorrow”; “Create a calendar event: title | YYYY-MM-DD HH:MM | minutes”"],
      calendarWrite: "events",
      contacts: ["Contacts", "“Search contacts for Ivan”"],
      contactsBoth: ["Contacts", "“Search contacts for Ivan”; “Add a contact: name | email | phone”"],
      contactsWrite: "contacts",
      gmail: ["Gmail", "“Show my Gmail”"],
      gmailBoth: ["Gmail", "“Show my Gmail”; “Send an email to address | subject | text” (to me — to you)"],
      gmailSend: ["Gmail", "“Send an email to address | subject | text” (to me — to you)"],
      gmailSendOnly: ["Gmail (sending)"],
      gmailRead: ["Reading Gmail"],
      mailSend: "emails",
      drive: ["Google Drive", "“Show my Google Drive files”; “Save to Google” button"],
      driveSave: ["Google Drive", "“Save to Google” button"],
      driveSaveOnly: ["Google Drive (saving)"],
      driveRead: ["Reading Drive"],
      youtube: ["YouTube channel", "“Show my YouTube channel”"],
      youtubeVideo: ["YouTube videos", "summary by link"],
      places: ["Maps", "“Find a cafe near me”"],
      web: ["Web", "“Do a web search for …”"],
      media: {
        both: ["Pictures and video", "describe; “yes” makes them"],
        images: ["Pictures", "describe; “yes” makes them"],
        video: ["Video", "describe; “yes” makes it"],
      },
      // The work-task and memory commands are Bulgarian words only.
      tasks: ["Work tasks", "“Покажи работните задачи”"],
      todos: ["My tasks", "“My tasks”; “Add a task: call the bank tomorrow”"],
      memory: ["Memory", "“Запомни: …”"],
      memoryWrite: "memory",
      files: ["My files", "ask about an added file"],
      claude: ["Work with Claude", "in “Add-ons”"],
      github: ["GitHub", "“Latest commit on GitHub”"],
      githubWrite: ["GitHub changes"],
      codeWrite: "GitHub",
      cloud: ["Google Cloud", "“Show the Google Cloud runtime”"],
      cloudWrite: "Google Cloud",
    },
    press: {
      google: "“Connect Google”",
      googleAgain: "“Connect Google again”",
      gmail: "“Allow Gmail”",
      drive: "“Allow Google Drive”",
      youtube: "“Allow YouTube”",
      github: "“Connect GitHub”",
    },
    asks: {
      gmail: "“Show my Gmail”",
      drive: "“Show my Google Drive files”",
      youtube: "“Show my YouTube channel”",
    },
    inAnswer: (ask, button) => `${ask}, then ${button} in the answer`,
    afterGoogle: (google, ask, button) => `${google}, then ${ask} and ${button} in the answer`,
  },
};

// What the first „Свържи Google“ grants (the same for everyone, the owner
// too: googleDriveRouter.js): the services whose need it covers are turned on
// by that press; the others are a second step from an answer.
const FIRST_GOOGLE_SCOPES = new Set(GOOGLE_MEMBER_SCOPES);

const textFor = (language) => TEXT[useEnglishReplyFallback(language) ? "en" : "bg"];

// One capability through the checks the chat makes before it runs it: this
// account's role and the member policy (a member's own Google counts once it
// is connected), the registry and the permission policy, then the site's
// settings and this account's sessions.
// A tool left out by the switches: turned off by the person, or (when the
// switches could not be read) only paused for this answer.
const offStatus = (capabilitiesOff) => (capabilitiesOff?.unavailable ? "unavailable" : "unplugged");

function capabilityStatus(capability, { identity, env, input, capabilitiesOff }) {
  if (!filterCapabilityRequestsForIdentity([{ capability }], identity, { ownGoogle: true }).length) {
    return "off";
  }
  if (capabilitiesOff?.has?.(capability)) return offStatus(capabilitiesOff);
  let tool;
  try {
    ({ tool } = resolveCapability(capability));
  } catch {
    return "off";
  }
  const runtime = getToolRuntimeAvailability(tool.id, input, env);
  if (runtime.available) return "ready";
  return runtime.code === "CAPABILITY_AUTH_REQUIRED" ? "connect" : "off";
}

// The site's document store (Firestore, or the in-process one outside
// production) that "Моите задачи", "Моите файлове" and "Работа с Claude" keep
// their records in.
function documentStoreReady(env) {
  return resolvePersistenceBackend(env) === "local" || isPersistenceBackendConfigured(env);
}

function defaultMemory(env) {
  return resolveMemoryBackend(env) === "local" || isMemoryBackendConfigured(env);
}

function entry(id, status, [label, example = ""], { confirm = "", press = "" } = {}) {
  return Object.freeze({ id, status, label, example, confirm, press });
}

// The tools this account can use now, as entries { id, status: "ready" |
// "connect" | "unplugged" | "unavailable" | "off", label, example, confirm,
// press }, grouped as a person thinks of them; "unplugged" is a tool the
// person turned off with „Разкачи“ (`capabilitiesOff`, from
// toolSwitchService.js), "unavailable" one left out because the switches
// could not be read. `connections.google` is the route's read of this account's
// own Google connection ({ scopes } from googleConnectionFor, or null) and
// `connections.githubSessionId` its GitHub session; `memory` says whether this
// request's memory read worked; `media` is what this account can make
// (mediaAvailability); `mode` is the chat mode: the person's own files are
// read only outside Work mode. A member never gets an owner-only entry.
export function buildToolInventory({
  identity = null,
  env = process.env,
  connections = {},
  language,
  mode = "chat",
  memory = defaultMemory(env),
  media = mediaAvailability(env, { member: identity?.role !== "owner" }),
  capabilitiesOff = null,
} = {}) {
  const { tools, press, asks, inAnswer, afterGoogle } = textFor(language);
  const owner = identity?.role === "owner";
  const google = Array.isArray(connections?.google?.scopes) ? connections.google : null;
  const granted = new Set(google?.scopes);
  const has = (need) => GOOGLE_NEEDS[need].some((item) => granted.has(item));
  const input = Object.freeze({
    ownerId: identity?.memoryOwnerId || "",
    // Only whether there is a session is read.
    googleSessionId: google ? "this-account" : "",
    githubSessionId: typeof connections?.githubSessionId === "string" ? connections.githubSessionId : "",
  });
  const status = (capability) => capabilityStatus(capability, { identity, env, input, capabilitiesOff });
  // A Google service is "scope" when it is connected but Google did not grant
  // what it needs.
  const googleStatus = (capability, need) => {
    const value = status(capability);
    return value === "ready" && !has(need) ? "scope" : value;
  };
  const ready = (capability, need) => status(capability) === "ready" && has(need);
  const firstGrants = (need) => GOOGLE_NEEDS[need].some((item) => FIRST_GOOGLE_SCOPES.has(item));
  // A Google service that is not ready: „Свържи Google“ until there is a
  // connection when that press turns it on, or that press and then its own
  // step from an answer (review r6: YouTube, reading Gmail and reading Drive
  // are second steps); with a connection, the service's own step. `need` is
  // what the service needs, `ask` the words whose answer shows `step`'s
  // button ("" when the step is a button of the page).
  const notReady = (id, value, words, step, need, ask = "") =>
    value === "unplugged" || value === "unavailable"
      ? entry(id, value, words)
      : value === "connect"
        ? entry(id, "connect", words, {
            press: !need || firstGrants(need) ? press.google : afterGoogle(press.google, ask, step),
          })
        : value === "scope"
          ? entry(id, "connect", words, { press: ask ? inAnswer(ask, step) : step })
          : entry(id, "off", words);
  const entries = [];

  const calendar = googleStatus("calendar.read", "calendar");
  entries.push(
    calendar === "ready"
      ? entry("calendar", "ready", ready("calendar.write", "calendarWrite") ? tools.calendarBoth : tools.calendar, {
          confirm: ready("calendar.write", "calendarWrite") ? tools.calendarWrite : "",
        })
      : notReady("calendar", calendar, tools.calendar, press.googleAgain, "calendar"),
  );
  const contacts = googleStatus("contacts.read", "contacts");
  entries.push(
    contacts === "ready"
      ? entry("contacts", "ready", ready("contacts.create", "contactsWrite") ? tools.contactsBoth : tools.contacts, {
          confirm: ready("contacts.create", "contactsWrite") ? tools.contactsWrite : "",
        })
      : notReady("contacts", contacts, tools.contacts, press.googleAgain, "contacts"),
  );
  const mailRead = googleStatus("mail.read", "mailRead");
  const send = ready("mail.send", "mailSend") ? tools.mailSend : "";
  if (mailRead === "ready") {
    entries.push(entry("gmail", "ready", send ? tools.gmailBoth : tools.gmail, { confirm: send }));
  } else if (send) {
    // Sending works; reading the mailbox is Google's separate step.
    entries.push(entry("gmail", "ready", tools.gmailSend, { confirm: send }));
    if (mailRead === "scope") {
      entries.push(entry("gmail-read", "connect", tools.gmailRead, { press: inAnswer(asks.gmail, press.gmail) }));
    }
  } else if (mailRead === "connect" && !firstGrants("mailRead") && firstGrants("mailSend")) {
    // The first press turns on sending only.
    entries.push(entry("gmail", "connect", tools.gmailSendOnly, { press: press.google }));
  } else {
    entries.push(notReady("gmail", mailRead, tools.gmail, press.gmail, "mailRead", asks.gmail));
  }
  const drive = googleStatus("files.read", "drive");
  if (drive === "scope") {
    // "Запази в Google" works with any connection: its own step asks Google.
    entries.push(entry("drive", "ready", tools.driveSave));
    entries.push(entry("drive-read", "connect", tools.driveRead, { press: inAnswer(asks.drive, press.drive) }));
  } else if (drive === "connect" && !firstGrants("drive")) {
    // The first press turns on saving („Запази в Google“ asks its own step).
    entries.push(entry("drive", "connect", tools.driveSaveOnly, { press: press.google }));
  } else {
    entries.push(drive === "ready" ? entry("drive", "ready", tools.drive) : notReady("drive", drive, tools.drive));
  }
  const youtube = googleStatus("youtube.channel", "youtube");
  entries.push(
    youtube === "ready"
      ? entry("youtube", "ready", tools.youtube)
      : notReady("youtube", youtube, tools.youtube, press.youtube, "youtube", asks.youtube),
  );
  entries.push(entry("youtube-video", status("video.read"), tools.youtubeVideo));
  entries.push(entry("places", status("places.search"), tools.places));
  entries.push(entry("web", status("web.search"), tools.web));

  const kinds = media?.images && media?.video ? "both" : media?.images ? "images" : media?.video ? "video" : "";
  entries.push(entry("media", kinds ? "ready" : "off", tools.media[kinds || "both"]));

  const store = documentStoreReady(env);
  // The owner's chat also reads the work drafts („Работни задачи“); "Моите
  // задачи" is the list every account keeps, read and added to in the chat
  // too (item 3, fix 4), so both are named for what they are (review r6).
  if (owner) entries.push(entry("tasks", status("tasks.read"), tools.tasks));
  entries.push(entry("todos", store ? (capabilitiesOff?.has?.("todos.read") ? offStatus(capabilitiesOff) : "ready") : "off", tools.todos));
  // "Запомни: …" is written when the person sends it themselves (or presses
  // „Запомни“): their exact words are the confirmation, as for an event, a
  // contact or an email (RADKO 28.11 04:30, 06:35).
  entries.push(entry("memory", memory ? "ready" : "off", tools.memory, { confirm: tools.memoryWrite }));
  entries.push(entry("files", store && mode !== "work" ? "ready" : "off", tools.files));
  entries.push(entry("claude", store && Boolean(env?.ANTHROPIC_API_KEY) ? "ready" : "off", tools.claude));

  if (owner) {
    const github = status("code.read");
    const codeWrite = status("code.write");
    entries.push(entry("github", github, tools.github, { confirm: codeWrite === "ready" ? tools.codeWrite : "" }));
    if (github === "ready" && codeWrite === "connect") {
      entries.push(entry("github-write", "connect", tools.githubWrite, { press: press.github }));
    }
    entries.push(
      entry("cloud", status("infrastructure.googlecloud.read"), tools.cloud, {
        confirm: status("infrastructure.googlecloud.write") === "ready" ? tools.cloudWrite : "",
      }),
    );
  }
  return Object.freeze(entries);
}

function render(entries, text, { examples = true } = {}) {
  const ready = entries.filter(({ status }) => status === "ready");
  const confirms = [...new Set(ready.map(({ confirm }) => confirm).filter(Boolean))];
  const labelsOf = (wanted) => [...new Set(entries.filter(({ status }) => status === wanted).map(({ label }) => label))];
  const unplugged = labelsOf("unplugged");
  const unavailable = labelsOf("unavailable");
  // One line per button or path: „Свържи Google“ turns on the services its
  // first press grants; the others name that press and their own step.
  const connect = new Map();
  for (const { status, label, press } of entries) {
    if (status === "connect" && press) connect.set(press, [...(connect.get(press) || []), label]);
  }
  return [
    `${TOOL_INVENTORY_HEADING} ${text.checked}`,
    ...(ready.length
      ? [text.ready, ...ready.map(({ label, example }) => (examples && example ? `${label} — ${example}` : label))]
      : [text.none]),
    ...(connect.size ? [text.connect, ...[...connect].map(([press, labels]) => `${labels.join(", ")} — ${press}`)] : []),
    ...(unplugged.length ? [`${text.unplugged} ${unplugged.join(", ")}`] : []),
    ...(unavailable.length ? [`${text.unavailable} ${unavailable.join(", ")}`] : []),
    // With no tool ready, only the first rule: the second would push against
    // the true answer (review r6).
    ...(ready.length ? text.rules : text.rules.slice(0, 1)),
    text.confirm(confirms.join(", ")),
  ].join("\n");
}

// The system section for the chat model, in the page's language: Bulgarian on
// a Bulgarian page, English on every other. It stays within
// MAX_TOOL_INVENTORY_LENGTH; should a list ever be longer, the ready tools are
// named without their examples rather than left out.
export function toolInventorySection(entries, { language } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const text = textFor(language);
  const full = render(list, text);
  return full.length <= MAX_TOOL_INVENTORY_LENGTH ? full : render(list, text, { examples: false });
}

// A question about which tools the chat has or what it can do: „С кои
// инструменти можеш да работиш?“, „Какво можеш?“, „Имаш ли инструменти?“,
// „Кои инструменти са ти достъпни?“, „Изброй инструментите си“, "What tools
// can you use?", or a request to use "the tools" without naming one
// („Ползвай инструментите за писане“, also as the owner types it, „ПОЛЗВАИ“,
// and as the agent writes its step, „използвам инструмента Календар“). The
// chat answers it from its tool list, so it starts no status check; a tool
// the same words ask for still runs. A check of the tools („Работят ли
// инструментите?“, „Провери кои инструменти работят“, „Кои инструменти
// можеш да ползваш и провери дали работят“) stays a real check: the check
// verbs as whole words, except when they check data („провери пощата“), and
// the status words (review r6: the bare stems „достъпн“ and „провер“ made
// „Кои инструменти са ти достъпни?“ a status check).
const TOOL_STATUS_CHECK =
  /(?:(?:^|[^\p{L}])(?:провери|проверете|тествай|тествайте)(?!\p{L})(?!\s+(?:ми\s+)?(?:пощата|писмата|имейлите|календара|програмата|контактите|файловете|gmail|drive))|статус|състояни|работ(?:ят|и)\s+ли|(?:достъпни|активни|свързани)\s+ли|ли\s+(?:са|е)\s+(?:достъпни|активни|свързани)|\bcheck\b|\btest\b|\bstatus\b|\bworking\b)/iu;
const TOOL_INVENTORY_QUESTIONS = [
  /(?:^|[^\p{L}])(?:кои|какви)\s+(?:(?:са|точно)\s+)?(?:(?:твоите|ти)\s+)?(?:инструмент(?:и|ите)|възможност(?:и|ите))(?:\s+(?:ти|си|сега|тук|още))*\s+(?:можеш|имаш|ползваш|използваш|работиш|разполагаш)(?!\p{L})/iu,
  /(?:^|[^\p{L}])какво\s+(?:(?:още|точно|друго)\s+)?(?:можеш|умееш)(?:\s+да\s+(?:правиш|направиш|вършиш))?(?:\s+(?:сега|тук|за\s+мен|в\s+момента|(?:с|със|в)\s+[^?.!\n]{1,40}))?[\s?.!]*$/iu,
  /\b(?:what|which)\s+(?:tools|integrations|capabilities)\s+(?:can|could|do)\s+you\b/iu,
  /\bwhat\s+(?:else\s+)?can\s+you\s+do(?:\s+(?:for\s+me|here|now|(?:with|in)\s+[^?.!\n]{1,40}))?[\s?.!]*$/iu,
  /\bwhat\s+are\s+your\s+(?:tools|capabilities)\b/iu,
  // „Изброй инструментите си“, anchored at the sentence's end: „Покажи
  // инструментите за GitHub и промени README“ asks for a change.
  /(?:^|[^\p{L}])(?:изброй|кажи|покажи|опиши)\s+(?:ми\s+)?(?:си\s+)?(?:всички\s+)?(?:(?:твоите|своите|наличните)\s+)?инструмент(?:и|ите)(?:\s+си)?(?:\s*,?\s*(?:които|с\s+които)\s+[^?.!\n]{0,60})?[\s?.!]*$/iu,
  /(?:^|[^\p{L}])имаш\s+ли\s+(?:някакви\s+|други\s+|още\s+)?инструмент(?:и|ите)?(?!\p{L})/iu,
  /(?:^|[^\p{L}])(?:кои|какви)\s+(?:(?:твоите|ти)\s+)?инструмент(?:и|ите)(?:\s+(?:ти|си|сега|тук|още))*\s+(?:са\s+)?(?:ти\s+)?(?:достъпни|на\s+разположение)(?!\p{L})/iu,
];
const USE_THE_TOOLS =
  /(?:^|[^\p{L}])(?:ползва[йим]|използва[йим]|пускам)\s+(?:(?:твоите|своите|наличните|всички(?:те)?)\s+)?(?:си\s+)?инструмент(?:а|ите|и)?(?!\p{L})/iu;

function inventoryText(message) {
  const text = typeof message === "string" ? message.trim() : "";
  return !text || text.length > 300 || TOOL_STATUS_CHECK.test(text) ? "" : text;
}

export function isToolInventoryQuestion(message) {
  const text = inventoryText(message);
  return Boolean(text) && (USE_THE_TOOLS.test(text) || TOOL_INVENTORY_QUESTIONS.some((pattern) => pattern.test(text)));
}

// Only a question about the tools, not a request to use them: „Използвай
// инструментите и слей PR #12 в GitHub“ asks for the merge, while „С кои
// инструменти можеш да промениш кода в GitHub?“ asks about the tools.
export function isToolListQuestion(message) {
  const text = inventoryText(message);
  return Boolean(text) && TOOL_INVENTORY_QUESTIONS.some((pattern) => pattern.test(text));
}
