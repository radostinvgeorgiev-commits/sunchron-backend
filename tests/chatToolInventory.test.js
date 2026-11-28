import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";

// The chat route reads these when it loads. None of them is a real key.
process.env.NODE_ENV = "test";
process.env.AI_CORE_PROVIDER = "claude";
process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
process.env.OPENAI_API_KEY = "test-openai-key";
process.env.GEMINI_API_KEY = "test-gemini-key";
process.env.GOOGLE_CLIENT_ID = "test-google-client";
process.env.GOOGLE_CLIENT_SECRET = "test-google-secret";
process.env.GOOGLE_REDIRECT_URI = "https://novarium.test/api/google/callback";
delete process.env.ANTHROPIC_MODEL;

const {
  default: chatRouter,
  buildAvatarMessages,
  buildContextualTaskMessage,
  detectCapabilityRequests,
  isToolInventoryMessage,
  replyLanguageRule,
} = await import("../src/routes/chat.js");
const {
  MAX_TOOL_INVENTORY_LENGTH,
  TOOL_INVENTORY_HEADING,
  buildToolInventory,
  isToolInventoryQuestion,
  toolInventorySection,
} = await import("../src/services/chatToolInventory.js");
const { mediaAvailability, mediaToolsRule } = await import("../src/services/chatMediaProposals.js");
const {
  GOOGLE_BASE_SCOPES,
  GOOGLE_EXTRA_SCOPES,
  GOOGLE_MEMBER_SCOPES,
  createSession,
  googleConnectionFor,
} = await import("../src/services/googleDriveService.js");
const { extractPersistentMemoryCommands } = await import("../src/services/memoryService.js");
const { createPublicAiBudgetContext } = await import("../src/services/publicAiBudget.js");
const { getProductPlansService } = await import("../src/services/productPlansService.js");

const owner = { id: "owner", login: "owner", displayName: "Радко", role: "owner", memoryOwnerId: "inventory-owner" };
const member = {
  id: "inventory-member",
  displayName: "Ана",
  role: "member",
  authProvider: "identity-platform",
  memoryOwnerId: "identity-platform:inventory-member",
};

// The live site: every key, Firestore and Cloud Run. The values stand in for
// keys; only whether a key is there is read.
const siteEnv = Object.freeze({
  NODE_ENV: "production",
  GOOGLE_CLOUD_PROJECT: "novarium-prod",
  K_SERVICE: "novarium",
  K_REVISION: "novarium-00001",
  OPENAI_API_KEY: "stand-in",
  GEMINI_API_KEY: "stand-in",
  ANTHROPIC_API_KEY: "stand-in",
  GOOGLE_CLIENT_ID: "stand-in",
  GOOGLE_CLIENT_SECRET: "stand-in",
  GOOGLE_REDIRECT_URI: "https://novarium.test/api/google/callback",
  GITHUB_CLIENT_ID: "stand-in",
  GITHUB_CLIENT_SECRET: "stand-in",
});
const without = (...names) => Object.fromEntries(Object.entries(siteEnv).filter(([name]) => !names.includes(name)));
const scope = (name) => `https://www.googleapis.com/auth/${name}`;
const googleWith = (scopes, extra = {}) => ({ google: { scopes: [...scopes] }, ...extra });
// The owner's „Свържи Google“ with YouTube turned on, and their GitHub sign-in.
const ownerGoogle = googleWith([...GOOGLE_BASE_SCOPES, GOOGLE_EXTRA_SCOPES.youtube], { githubSessionId: "github-session" });
// A member's first „Свържи Google“.
const memberGoogle = googleWith(GOOGLE_MEMBER_SCOPES);

const statuses = (entries) => Object.fromEntries(entries.map(({ id, status }) => [id, status]));
const byId = (entries, id) => entries.find((item) => item.id === id);
const sectionOf = (system) => system.split("\n\n").find((part) => part.startsWith(TOOL_INVENTORY_HEADING));
const OWNER_ONLY = ["tasks", "github", "github-write", "cloud"];
// The owner's question on the live site, 27.11 at 22:21.
const QUESTION = "С КОИ ИНСТРУМЕНТИ МОЖЕШ СЕГА ДА РАБОТИШ";

// ── The tool list ─────────────────────────────────────────────────────────

test("the owner on the live site, with Google and GitHub connected, has every tool ready", () => {
  const entries = buildToolInventory({ identity: owner, env: siteEnv, connections: ownerGoogle });
  assert.deepEqual(
    entries.map(({ id, status }) => [id, status]),
    [
      ["calendar", "ready"],
      ["contacts", "ready"],
      ["gmail", "ready"],
      ["drive", "ready"],
      ["youtube", "ready"],
      ["youtube-video", "ready"],
      ["places", "ready"],
      ["web", "ready"],
      ["media", "ready"],
      ["tasks", "ready"],
      ["memory", "ready"],
      ["files", "ready"],
      ["claude", "ready"],
      ["github", "ready"],
      ["cloud", "ready"],
    ],
  );
  // What each write waits for: the exact confirmation.
  assert.deepEqual(
    entries.filter(({ confirm }) => confirm).map(({ id, confirm }) => [id, confirm]),
    [
      ["calendar", "събития"],
      ["contacts", "контакти"],
      ["gmail", "имейли"],
      ["memory", "памет"],
      ["github", "GitHub"],
      ["cloud", "Google Cloud"],
    ],
  );
  assert.ok(Object.isFrozen(entries) && entries.every(Object.isFrozen));
  for (const item of entries) {
    assert.deepEqual(Object.keys(item), ["id", "status", "label", "example", "confirm", "press"]);
    assert.equal(item.press, "");
  }
  assert.equal(byId(entries, "media").label, "Картинки и видео");
  // The chat reads the owner's tasks itself, so the page list is not named too.
  assert.equal(byId(entries, "todos"), undefined);
});

test("a member after the first „Свържи Google“: calendar, contacts, sending and saving work; the rest name their own step", () => {
  const entries = buildToolInventory({ identity: member, env: siteEnv, connections: memberGoogle });
  assert.deepEqual(
    entries.map(({ id, status, press }) => [id, status, press]),
    [
      ["calendar", "ready", ""],
      ["contacts", "ready", ""],
      ["gmail", "ready", ""],
      ["gmail-read", "connect", "„Разреши Gmail“"],
      ["drive", "ready", ""],
      ["drive-read", "connect", "„Разреши Google Drive“"],
      ["youtube", "connect", "„Свържи YouTube“"],
      ["youtube-video", "ready", ""],
      ["places", "ready", ""],
      ["web", "ready", ""],
      ["media", "ready", ""],
      ["todos", "ready", ""],
      ["memory", "ready", ""],
      ["files", "ready", ""],
      ["claude", "ready", ""],
    ],
  );
  // Sending works, so Gmail's example is a send; "Запази в Google" works with
  // any connection, so Drive's is the button.
  assert.deepEqual(byId(entries, "gmail"), {
    id: "gmail",
    status: "ready",
    label: "Gmail",
    example: "„Изпрати имейл до адрес | тема | текст“",
    confirm: "имейли",
    press: "",
  });
  assert.equal(byId(entries, "drive").example, "бутон „Запази в Google“");
  assert.equal(byId(entries, "calendar").confirm, "събития");
  assert.equal(byId(entries, "contacts").confirm, "контакти");
});

test("without a Google connection every Google tool waits for „Свържи Google“, in one line", () => {
  for (const identity of [owner, member]) {
    const entries = buildToolInventory({ identity, env: siteEnv, connections: {} });
    for (const id of ["calendar", "contacts", "gmail", "drive", "youtube"]) {
      assert.equal(byId(entries, id).status, "connect", `${identity.role} ${id}`);
      assert.equal(byId(entries, id).press, "„Свържи Google“");
      assert.equal(byId(entries, id).confirm, "");
    }
    // The tools that need no Google still work.
    for (const id of ["youtube-video", "places", "web", "media", "memory", "files", "claude"]) {
      assert.equal(byId(entries, id).status, "ready", `${identity.role} ${id}`);
    }
    const section = toolInventorySection(entries);
    assert.ok(
      section.includes("\nИскат свързване:\nКалендар, Контакти, Gmail, Google Drive, YouTube канал — „Свържи Google“\n"),
      section,
    );
    assert.ok(!section.includes("Календар — "), "a tool that is not connected has no example");
    // A connection that belongs to another account reads as none (see
    // googleConnectionFor below), so the list is the same.
    assert.deepEqual(buildToolInventory({ identity, env: siteEnv, connections: { google: null } }), entries);
  }
});

test("a connection Google gave less to names the step that adds it", () => {
  const partial = buildToolInventory({
    identity: member,
    env: siteEnv,
    connections: googleWith(["openid", "email", scope("calendar.readonly")]),
  });
  assert.deepEqual(
    partial.filter(({ status }) => status === "connect").map(({ id, press }) => [id, press]),
    [
      ["contacts", "„Свържи Google отново“"],
      ["gmail", "„Разреши Gmail“"],
      ["drive-read", "„Разреши Google Drive“"],
      ["youtube", "„Свържи YouTube“"],
    ],
  );
  // Reading the calendar works; a new event needs calendar.events.
  assert.deepEqual([byId(partial, "calendar").status, byId(partial, "calendar").confirm], ["ready", ""]);
  // After „Разреши Gmail“ and „Разреши Google Drive“ the whole mailbox and
  // Drive are read.
  const extended = buildToolInventory({
    identity: member,
    env: siteEnv,
    connections: googleWith([...GOOGLE_MEMBER_SCOPES, ...GOOGLE_EXTRA_SCOPES.gmail.split(" "), GOOGLE_EXTRA_SCOPES.drive]),
  });
  assert.equal(byId(extended, "gmail").example, "„Покажи писмата в Gmail“");
  assert.equal(byId(extended, "drive").example, "„Покажи Google Drive“; бутон „Запази в Google“");
  assert.equal(byId(extended, "gmail-read"), undefined);
  assert.equal(byId(extended, "drive-read"), undefined);
});

test("a site key that is missing turns its tools off; it never asks the person to connect", () => {
  const before = {
    owner: statuses(buildToolInventory({ identity: owner, env: siteEnv, connections: ownerGoogle })),
    member: statuses(buildToolInventory({ identity: member, env: siteEnv, connections: memberGoogle })),
  };
  const cases = [
    // The Google app's keys: every Google tool, even with a stored connection.
    [["GOOGLE_CLIENT_SECRET"], member, memberGoogle, ["calendar", "contacts", "gmail", "gmail-read", "drive", "drive-read", "youtube"]],
    [["GOOGLE_CLIENT_ID"], owner, ownerGoogle, ["calendar", "contacts", "gmail", "drive", "youtube"]],
    // Gemini: YouTube videos and maps.
    [["GEMINI_API_KEY"], owner, ownerGoogle, ["youtube-video", "places"]],
    // OpenAI: the web search.
    [["OPENAI_API_KEY"], member, memberGoogle, ["web"]],
    // Anthropic: "Работа с Claude".
    [["ANTHROPIC_API_KEY"], member, memberGoogle, ["claude"]],
    // No Firestore and not on Cloud Run: what is stored, and Google Cloud.
    [["GOOGLE_CLOUD_PROJECT", "K_SERVICE"], owner, ownerGoogle, ["tasks", "todos", "memory", "files", "claude", "cloud"]],
  ];
  for (const [missing, identity, connections, off] of cases) {
    const now = statuses(buildToolInventory({ identity, env: without(...missing), connections }));
    const was = before[identity.role];
    const changed = [...new Set([...Object.keys(was), ...Object.keys(now)])].filter((id) => now[id] !== was[id]);
    assert.deepEqual(changed.sort(), [...off].sort(), missing.join(", "));
    // A tool that cannot work is left out of both lists; it is not "connect".
    for (const id of off) assert.ok(now[id] === "off" || now[id] === undefined, `${missing}: ${id} is ${now[id]}`);
  }
  // GitHub's app keys: the owner still reads GitHub; changes are not offered.
  const noGitHubApp = buildToolInventory({ identity: owner, env: without("GITHUB_CLIENT_SECRET"), connections: ownerGoogle });
  assert.deepEqual([byId(noGitHubApp, "github").status, byId(noGitHubApp, "github").confirm], ["ready", ""]);
  // Without the owner's GitHub sign-in, changes wait for „Свържи GitHub“.
  const signedOut = buildToolInventory({ identity: owner, env: siteEnv, connections: { google: ownerGoogle.google } });
  assert.deepEqual(byId(signedOut, "github-write"), {
    id: "github-write",
    status: "connect",
    label: "Промени в GitHub",
    example: "",
    confirm: "",
    press: "„Свържи GitHub“",
  });
  // A site with nothing set up says so instead of naming tools.
  const bare = toolInventorySection(buildToolInventory({ identity: member, env: { NODE_ENV: "production" } }));
  assert.match(bare, /\nРаботят: нито един сега\.\n/u);
  assert.doesNotMatch(bare, /Искат свързване/u);
});

test("pictures and video come from mediaAvailability; a member whose video is closed sees only pictures", () => {
  for (const env of [siteEnv, without("OPENAI_API_KEY"), without("GEMINI_API_KEY"), { OPENAI_API_KEY: "stand-in" }, {}]) {
    for (const identity of [owner, member]) {
      const media = mediaAvailability(env, { member: identity.role !== "owner" });
      const entry = byId(buildToolInventory({ identity, env, connections: {} }), "media");
      assert.equal(entry.status, media.images || media.video ? "ready" : "off");
      if (entry.status === "ready") {
        assert.equal(entry.label, media.images && media.video ? "Картинки и видео" : media.images ? "Картинки" : "Видео");
      }
    }
  }
  // The route passes what it offers for this request: video closed for members.
  const closed = buildToolInventory({ identity: member, env: siteEnv, connections: {}, media: { images: true, video: false } });
  assert.deepEqual(byId(closed, "media"), {
    id: "media",
    status: "ready",
    label: "Картинки",
    example: "опиши ги; „да“ ги прави",
    confirm: "",
    press: "",
  });
  const section = toolInventorySection(closed);
  assert.ok(section.includes("\nКартинки — опиши ги; „да“ ги прави\n"), section);
  assert.doesNotMatch(section, /Картинки и видео|\nВидео — /u);
  const english = toolInventorySection(
    buildToolInventory({ identity: member, env: siteEnv, language: "en", media: { images: true, video: false } }),
    { language: "en" },
  );
  assert.ok(english.includes("\nPictures — describe; “yes” makes them\n"), english);
  assert.doesNotMatch(english, /Pictures and video/u);
  // Nothing to make (a photo sent for reading): not listed as working.
  const none = buildToolInventory({ identity: owner, env: siteEnv, media: { images: false, video: false } });
  assert.equal(byId(none, "media").status, "off");
  assert.doesNotMatch(toolInventorySection(none), /Картинки|Видео —/u);
});

test("memory, files and Work mode follow this request", () => {
  // The memory read failed for this request: "Запомни" is not offered.
  const noMemory = buildToolInventory({ identity: member, env: siteEnv, memory: false });
  assert.equal(byId(noMemory, "memory").status, "off");
  assert.doesNotMatch(toolInventorySection(noMemory), /Памет|записи \(памет\)/u);
  // The person's own files are read only outside Work mode.
  assert.equal(byId(buildToolInventory({ identity: member, env: siteEnv, mode: "work" }), "files").status, "off");
  assert.equal(byId(buildToolInventory({ identity: member, env: siteEnv, mode: "chat" }), "files").status, "ready");
});

// Accounts, connections, site settings and pages the section is built for.
const ENVS = [
  siteEnv,
  without("GEMINI_API_KEY"),
  without("OPENAI_API_KEY"),
  without("GOOGLE_CLIENT_SECRET"),
  without("GITHUB_CLIENT_SECRET"),
  without("GOOGLE_CLOUD_PROJECT", "K_SERVICE"),
  { NODE_ENV: "test", OPENAI_API_KEY: "stand-in", GEMINI_API_KEY: "stand-in", ANTHROPIC_API_KEY: "stand-in" },
  {},
  { NODE_ENV: "production" },
];
const SCOPE_SETS = [
  null,
  [],
  GOOGLE_MEMBER_SCOPES,
  GOOGLE_BASE_SCOPES,
  [...GOOGLE_BASE_SCOPES, GOOGLE_EXTRA_SCOPES.youtube],
  [...GOOGLE_BASE_SCOPES, GOOGLE_EXTRA_SCOPES.youtube, scope("drive")],
  ["openid", "email", GOOGLE_EXTRA_SCOPES.save],
  ["openid", "email", scope("calendar.readonly")],
  ["openid", "email", scope("gmail.readonly")],
  [...GOOGLE_MEMBER_SCOPES, ...GOOGLE_EXTRA_SCOPES.gmail.split(" ")],
  [...GOOGLE_MEMBER_SCOPES, GOOGLE_EXTRA_SCOPES.drive],
  [...GOOGLE_MEMBER_SCOPES, GOOGLE_EXTRA_SCOPES.youtube],
];
function* everyList() {
  for (const identity of [owner, member]) {
    for (const env of ENVS) {
      for (const scopes of SCOPE_SETS) {
        for (const githubSessionId of ["", "github-session"]) {
          for (const language of [undefined, "en", "de"]) {
            for (const mode of ["chat", "work"]) {
              for (const media of [undefined, { images: true, video: false }, { images: false, video: false }]) {
                const options = {
                  identity,
                  env,
                  connections: { google: scopes ? { scopes: [...scopes] } : null, githubSessionId },
                  language,
                  mode,
                  ...(media ? { media } : {}),
                };
                yield { options, entries: buildToolInventory(options) };
              }
            }
          }
        }
      }
    }
  }
}

test("a member never sees GitHub, Google Cloud or the owner's task reading", () => {
  let lists = 0;
  for (const { options, entries } of everyList()) {
    if (options.identity !== member) continue;
    lists += 1;
    assert.deepEqual(entries.filter(({ id }) => OWNER_ONLY.includes(id)), [], JSON.stringify(options.connections));
    const section = toolInventorySection(entries, { language: options.language });
    assert.doesNotMatch(section, /GitHub|Google Cloud/u, section);
  }
  assert.ok(lists > 1000);
  // An account without the owner's role is not the owner, whatever it holds.
  for (const identity of [null, { memoryOwnerId: "x" }, { role: "guest", memoryOwnerId: "x" }]) {
    const entries = buildToolInventory({ identity, env: siteEnv, connections: ownerGoogle });
    assert.deepEqual(entries.filter(({ id }) => OWNER_ONLY.includes(id)), []);
  }
});

test("the section stays within 1,200 characters with every example, for every account and page", () => {
  let longest = 0;
  for (const { options, entries } of everyList()) {
    const section = toolInventorySection(entries, { language: options.language });
    longest = Math.max(longest, section.length);
    assert.ok(section.length <= MAX_TOOL_INVENTORY_LENGTH, `${section.length}: ${section}`);
    assert.ok(section.startsWith(`${TOOL_INVENTORY_HEADING} `));
    // No blank line inside: the system context joins its sections with one.
    assert.ok(!section.includes("\n\n"));
    for (const { status, label, example } of entries) {
      if (status === "ready" && example) assert.ok(section.includes(`\n${label} — ${example}\n`), `${label} — ${example}`);
    }
  }
  assert.ok(longest > 1100, `the longest list was measured: ${longest}`);
  // Should a list ever be longer, the working tools are named without their
  // examples rather than left out.
  const long = Array.from({ length: 30 }, (_, index) =>
    Object.freeze({
      id: `tool-${index}`,
      status: "ready",
      label: `Инструмент ${index}`,
      example: "„Много дълга примерна заявка за този инструмент“",
      confirm: "",
      press: "",
    }),
  );
  const short = toolInventorySection(long);
  assert.ok(short.length <= MAX_TOOL_INVENTORY_LENGTH, String(short.length));
  assert.ok(short.includes("\nИнструмент 0\n") && short.includes("\nИнструмент 29\n"));
  assert.doesNotMatch(short, /Много дълга/u);
});

// The exact text the model gets, on the live site.
const OWNER_SECTION = [
  "[ТВОИТЕ ИНСТРУМЕНТИ СЕГА] Проверени при тази заявка: настройки на сайта и връзките на този акаунт.",
  "Работят:",
  "Календар — „Програмата ми за утре“",
  "Контакти — „Намери в контактите Иван“",
  "Gmail — „Покажи писмата в Gmail“",
  "Google Drive — „Покажи Google Drive“; бутон „Запази в Google“",
  "YouTube канал — „Покажи моя YouTube канал“",
  "YouTube видео — резюме по линк",
  "Карти — „Намери кафене наблизо“",
  "Интернет — „Потърси в интернет …“",
  "Картинки и видео — опиши ги; „да“ ги прави",
  "Задачи — „Покажи задачите ми“",
  "Памет — „Запомни: …“",
  "Моите файлове — питай за качен файл",
  "Работа с Claude — в „Добавки“",
  "GitHub — „Последният commit в GitHub“",
  "Google Cloud — „Провери Google Cloud“",
  "Питат ли какво можеш, изброй работещите с пример, после чакащите свързване.",
  "Системата пуска инструмента преди отговора ти; резултатът идва в [РЕЗУЛТАТИ ОТ ИНСТРУМЕНТИ]. Без него кажи кой става и точните думи или ги дай в „Следва:“ („да“ го пуска). Не казвай, че нямаш инструменти.",
  "Резултати — само от тази заявка; записи (събития, контакти, имейли, памет, GitHub, Google Cloud), изпращане и публикуване — само с точното потвърждение.",
].join("\n");
const MEMBER_SECTION = [
  "[ТВОИТЕ ИНСТРУМЕНТИ СЕГА] Проверени при тази заявка: настройки на сайта и връзките на този акаунт.",
  "Работят:",
  "YouTube видео — резюме по линк",
  "Карти — „Намери кафене наблизо“",
  "Интернет — „Потърси в интернет …“",
  "Картинки и видео — опиши ги; „да“ ги прави",
  "Моите задачи — в менюто",
  "Памет — „Запомни: …“",
  "Моите файлове — питай за качен файл",
  "Работа с Claude — в „Добавки“",
  "Искат свързване:",
  "Календар, Контакти, Gmail, Google Drive, YouTube канал — „Свържи Google“",
  "Питат ли какво можеш, изброй работещите с пример, после чакащите свързване.",
  "Системата пуска инструмента преди отговора ти; резултатът идва в [РЕЗУЛТАТИ ОТ ИНСТРУМЕНТИ]. Без него кажи кой става и точните думи или ги дай в „Следва:“ („да“ го пуска). Не казвай, че нямаш инструменти.",
  "Резултати — само от тази заявка; записи (памет), изпращане и публикуване — само с точното потвърждение.",
].join("\n");
const ENGLISH_MEMBER_SECTION = [
  "[ТВОИТЕ ИНСТРУМЕНТИ СЕГА] Checked at this request: site settings and this account's connections.",
  "Working:",
  "Calendar — “My calendar tomorrow”",
  "Contacts — “Search contacts for Ivan”",
  "Gmail — “Send an email to address | subject | text”",
  "Google Drive — “Save to Google” button",
  "YouTube videos — summary by link",
  "Maps — “Find a cafe near me”",
  "Web — “Do a web search for …”",
  "Pictures and video — describe; “yes” makes them",
  "My tasks — in the menu",
  "Memory — “Запомни: …”",
  "My files — ask about an added file",
  "Work with Claude — in “Add-ons”",
  "Need connecting:",
  "Reading Gmail — “Allow Gmail”",
  "Reading Drive — “Allow Google Drive”",
  "YouTube channel — “Allow YouTube”",
  "Asked what you can do: the working tools with an example, then those to connect.",
  "The system runs tools before your answer; results come in [TOOL RESULTS]. Without one, name the fitting tool and its exact words, or put them in “Next:” (“yes” runs it). Never say you have no tools.",
  "Results only from this request; writes (events, contacts, emails, memory), sending and publishing only with the exact confirmation.",
].join("\n");

test("the section in plain words: the owner with Google, a member without it, a member on an English page", () => {
  assert.equal(toolInventorySection(buildToolInventory({ identity: owner, env: siteEnv, connections: ownerGoogle })), OWNER_SECTION);
  assert.equal(toolInventorySection(buildToolInventory({ identity: member, env: siteEnv, connections: {} })), MEMBER_SECTION);
  assert.equal(
    toolInventorySection(buildToolInventory({ identity: member, env: siteEnv, connections: memberGoogle, language: "en" }), {
      language: "en",
    }),
    ENGLISH_MEMBER_SECTION,
  );
});

test("Bulgarian on a Bulgarian page, English labels on every other page language", () => {
  const labels = (language) =>
    toolInventorySection(buildToolInventory({ identity: owner, env: siteEnv, connections: {}, language }), { language });
  const bulgarian = labels("bg");
  for (const language of [undefined, "", "xx", "bg-BG"]) assert.equal(labels(language), bulgarian, String(language));
  assert.match(bulgarian, /\nРаботят:\n/u);
  assert.match(bulgarian, /\nИскат свързване:\nКалендар, Контакти, Gmail, Google Drive, YouTube канал — „Свържи Google“\n/u);
  for (const language of ["en", "de", "fr", "es"]) {
    const page = labels(language);
    assert.equal(page, labels("en"), language);
    assert.ok(page.startsWith(`${TOOL_INVENTORY_HEADING} Checked at this request: site settings and this account's connections.\n`));
    assert.match(page, /\nWorking:\n/u);
    assert.match(page, /\nNeed connecting:\nCalendar, Contacts, Gmail, Google Drive, YouTube channel — “Connect Google”\n/u);
    assert.match(page, /\nGitHub — “Latest commit on GitHub”\n/u);
    // Only the task and memory commands are Bulgarian words: the chat runs
    // them only so.
    const bulgarianWords = page.split("\n").slice(1).join("\n").match(/[А-Яа-я][^“”\n]*/gu) || [];
    assert.deepEqual(bulgarianWords, ["Покажи задачите ми", "Запомни: …"], page);
  }
  // The same for each entry's own words.
  const english = buildToolInventory({ identity: owner, env: siteEnv, connections: ownerGoogle, language: "en" });
  assert.equal(byId(english, "calendar").label, "Calendar");
  assert.equal(byId(english, "calendar").confirm, "events");
  assert.equal(byId(english, "tasks").example, "“Покажи задачите ми”");
});

test("each example is a request the chat runs as it is written", () => {
  // The quoted words of an example, with a real address and a real topic in
  // place of the placeholders.
  const words = (example) =>
    example
      .match(/[„“]([^“”]+)[“”]/u)[1]
      .replace(/адрес|address/u, "ivan@example.com")
      .replace("Потърси в интернет …", "Потърси в интернет новини за Пловдив")
      .replace("Do a web search for …", "Do a web search for news about Plovdiv")
      .replace("Запомни: …", "Запомни: обичам чай");
  const runs = {
    calendar: "calendar.read",
    contacts: "contacts.read",
    gmail: "mail.read",
    drive: "files.read",
    youtube: "youtube.channel",
    places: "places.search",
    web: "web.search",
    tasks: "tasks.read",
    github: "code.read",
    cloud: "infrastructure.googlecloud.read",
  };
  for (const language of ["bg", "en"]) {
    const lists = [
      buildToolInventory({ identity: owner, env: siteEnv, connections: ownerGoogle, language }),
      // A member's Gmail example is a send.
      buildToolInventory({ identity: member, env: siteEnv, connections: memberGoogle, language }),
    ];
    const checked = [];
    for (const [index, entries] of lists.entries()) {
      for (const { id, example } of entries) {
        if (id === "memory") {
          assert.deepEqual(extractPersistentMemoryCommands(words(example)), [{ fact: "обичам чай", scope: "personal" }]);
          checked.push(id);
          continue;
        }
        if (!runs[id] || (index === 1 && id !== "gmail")) continue;
        const expected = index === 1 ? "mail.send" : runs[id];
        const found = detectCapabilityRequests(words(example), { toolInventory: true }).map(({ capability }) => capability);
        assert.deepEqual(found, [expected], `${language} ${id}: ${words(example)}`);
        checked.push(id);
      }
    }
    assert.deepEqual(checked.sort(), [...Object.keys(runs), "gmail", "memory", "memory"].sort(), language);
  }
});

// ── The system context ────────────────────────────────────────────────────

test("the system context carries the section for the owner and a member alike, before the media rule", () => {
  const both = { images: true, video: true };
  for (const [identity, connections] of [
    [owner, ownerGoogle],
    [member, {}],
  ]) {
    for (const language of [undefined, "en"]) {
      const tools = buildToolInventory({ identity, env: siteEnv, connections, language });
      const [system] = buildAvatarMessages([], [], "С КОИ ИНСТРУМЕНТИ МОЖЕШ СЕГА ДА РАБОТИШ", identity, {
        mode: "chat",
        language,
        media: both,
        tools,
      });
      const content = system.content;
      const section = toolInventorySection(tools, { language });
      assert.equal(sectionOf(content), section);
      assert.equal(content.split(TOOL_INVENTORY_HEADING).length, 2, "once");
      const rule = mediaToolsRule({ ...both, member: identity.role !== "owner", english: language === "en" });
      assert.ok(content.indexOf(section) < content.indexOf(rule));
      assert.ok(content.endsWith(replyLanguageRule(language)));
    }
  }
  // In Work mode too.
  const work = buildAvatarMessages([], [], "Какво можеш?", member, {
    mode: "work",
    workContext: { project: { name: "Реклама" } },
    tools: buildToolInventory({ identity: member, env: siteEnv, mode: "work" }),
  })[0].content;
  assert.ok(sectionOf(work));
  assert.match(work, /\[РАБОТЕН РЕЖИМ/u);
  // A caller that passes no list gets no section.
  assert.equal(sectionOf(buildAvatarMessages([], [], "Здравей", member, { mode: "chat" })[0].content), undefined);
});

// ── Questions about the tools ─────────────────────────────────────────────

test("a question about the tools starts no status check in the site chat", () => {
  const questions = [
    // 27.11, 22:19–22:21.
    "С КОИ ИНСТРУМЕНТИ МОЖЕШ СЕГА ДА РАБОТИШ",
    "С кои инструменти можеш да работиш?",
    "Какви инструменти можеш да ползваш?",
    "Кои инструменти можеш да използваш?",
    "До кои инструменти имаш достъп?",
    "Какви възможности имаш?",
    "какво можеш",
    "Какво можеш да правиш?",
    "Какво още можеш да правиш за мен?",
    "what tools can you use",
    "What tools do you have?",
    "What can you do?",
    "What else can you do for me?",
    "What are your capabilities?",
  ];
  for (const question of questions) {
    assert.equal(isToolInventoryQuestion(question), true, question);
    assert.equal(isToolInventoryMessage(question), true, question);
    assert.deepEqual(detectCapabilityRequests(question, { toolInventory: true }), [], question);
  }
  // A request to use "the tools" without naming one also starts no status
  // check, also as the owner types it (И for Й), but it is not a question
  // about the tools, so a change it asks for is still prepared (next test).
  for (const request of [
    // 27.11, 22:20.
    "ПОЛЗВАЙ ИНСТРУМЕНТИТЕ ЗА ПИСАНЕ МОЖЕШ ЛИ",
    "ПОЛЗВАИ ИНСТРУМЕНТИТЕ ЗА ПИСАНЕ МОЖЕШ ЛИ",
    "Използвай инструментите си",
    "ИЗПОЛЗВАИ ИНСТРУМЕНТИТЕ СИ",
  ]) {
    assert.equal(isToolInventoryQuestion(request), true, request);
    assert.equal(isToolInventoryMessage(request), false, request);
    assert.deepEqual(detectCapabilityRequests(request, { toolInventory: true }), [], request);
  }
  // Elsewhere (the MCP conversation) the detector is unchanged.
  assert.deepEqual(
    detectCapabilityRequests("С КОИ ИНСТРУМЕНТИ МОЖЕШ СЕГА ДА РАБОТИШ").map(({ capability }) => capability),
    ["system.integrations.status"],
  );
  // A question about a change in GitHub prepares no change.
  assert.deepEqual(
    detectCapabilityRequests("С кои инструменти можеш да промениш кода в GitHub?", { toolInventory: true }).map(
      ({ capability }) => capability,
    ),
    ["code.read"],
  );
});

test("a tool the same message asks for still runs, and a check of the tools stays a check", () => {
  const site = (message) => detectCapabilityRequests(message, { toolInventory: true }).map(({ capability }) => capability);
  // The status check is dropped; the tool asked for runs.
  assert.deepEqual(site("Използвай инструментите за календара и покажи срещите ми утре"), ["calendar.read"]);
  assert.deepEqual(site("Ползвай инструмента за поща и покажи последните писма в Gmail"), ["mail.read"]);
  assert.deepEqual(site("Използвай инструмента за карти: намери кафене наблизо"), ["places.search"]);
  assert.deepEqual(site("Какво можеш? Покажи календара ми за утре."), ["calendar.read"]);
  assert.deepEqual(site("Кои инструменти можеш да ползваш? Промени README в GitHub"), ["code.write"]);
  // A change or merge asked for together with "use the tools" is prepared.
  assert.deepEqual(site("Използвай инструментите и слей PR #12 в GitHub"), ["github.pull-request.merge"]);
  for (const change of [
    "Използвай инструментите и промени README в GitHub",
    "Ползвай инструментите си: промени README в GitHub",
    "Използвай инструмента за GitHub и обнови README",
    "Използвай всички инструменти и създай pull request с поправката в GitHub",
    "ПОЛЗВАИ ИНСТРУМЕНТИТЕ И ПРОМЕНИ README В GITHUB",
  ]) {
    assert.deepEqual(site(change), ["code.write"], change);
  }
  assert.equal(isToolInventoryMessage("Какво можеш? Покажи календара ми за утре."), false);
  // A question about one tool still reads it, as before.
  assert.deepEqual(site("What can you do with my Gmail?"), ["mail.read"]);
  // Checks of the tools are not questions about them.
  for (const check of [
    "А инструментите работят ли?",
    "Работят ли инструментите?",
    "Кои връзки са активни?",
    "Покажи статус на интеграциите.",
    "Можеш ли да използваш инструментите?",
    "Имаш ли достъп до инструментите?",
    "Можеш ли да използваш връзките?",
    "Какви инструменти работят сега?",
    "Провери с кои инструменти можеш да работиш",
    "Which tools are working?",
  ]) {
    assert.equal(isToolInventoryQuestion(check), false, check);
    assert.deepEqual(site(check), detectCapabilityRequests(check).map(({ capability }) => capability), check);
  }
  assert.deepEqual(site("А инструментите работят ли?"), ["system.integrations.status"]);
  // Not a question about the tools at all.
  for (const other of ["Какво можеш да ми кажеш за времето в Пловдив днес?", "А ПЛУГИНА КОИТО НАПРАВИХМЕ", "", "   "]) {
    assert.equal(isToolInventoryQuestion(other), false, other);
  }
  assert.equal(isToolInventoryQuestion(`Кои инструменти можеш да ползваш? ${"а".repeat(300)}`), false);
});

test("a tool the answer proposed as its Next step runs on a short yes", () => {
  for (const [ask, answer, yes, expected] of [
    [QUESTION, "Работи календарът.\n\nСледва: напиши „да“ и пускам „Програмата ми за утре“.", "да", "calendar.read"],
    ["Какво можеш?", "Търся места.\n\nСледва: напиши „да“ и търся „Намери кафене наблизо“.", "ДА", "places.search"],
    ["What tools can you use?", "Calendar works.\n\nNext: say yes and I will run “My calendar tomorrow”.", "yes", "calendar.read"],
  ]) {
    const taskMessage = buildContextualTaskMessage(yes, [
      { role: "user", content: ask },
      { role: "assistant", content: answer },
    ]);
    // The question before it starts no status check of its own.
    assert.deepEqual(
      detectCapabilityRequests(taskMessage, { toolInventory: true }).map(({ capability }) => capability),
      [expected],
      taskMessage,
    );
  }
});

// ── This account's Google connection ──────────────────────────────────────

test("googleConnectionFor reads this account's own stored session and calls no one", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("no network call");
  });
  const tokens = { access_token: "stand-in", expires_in: 3600 };
  const own = await createSession({ ...tokens, scope: GOOGLE_MEMBER_SCOPES.join(" ") }, member);
  const connection = await googleConnectionFor(own, member);
  assert.deepEqual(connection, { scopes: [...GOOGLE_MEMBER_SCOPES] });
  assert.ok(Object.isFrozen(connection) && Object.isFrozen(connection.scopes));
  // Another account's session, none, or an unknown one: not this account's.
  const other = await createSession({ ...tokens, scope: GOOGLE_BASE_SCOPES.join(" ") }, owner);
  assert.equal(await googleConnectionFor(other, member), null);
  assert.equal(await googleConnectionFor("", member), null);
  assert.equal(await googleConnectionFor("no-such-session", member), null);
  assert.equal(await googleConnectionFor(own, null), null);
  // A token stored without its scopes counts as the first „Свържи Google“.
  const bare = await createSession(tokens, member);
  assert.deepEqual(await googleConnectionFor(bare, member), { scopes: [...GOOGLE_MEMBER_SCOPES] });
  // A connection made before accounts belongs to the owner only.
  const old = await createSession({ ...tokens, scope: GOOGLE_BASE_SCOPES.join(" ") });
  assert.deepEqual(await googleConnectionFor(old, owner), { scopes: [...GOOGLE_BASE_SCOPES] });
  assert.equal(await googleConnectionFor(old, member), null);
  assert.equal(fetch.mock.callCount(), 0);
});

// ── The chat route ────────────────────────────────────────────────────────

// The chat route as server.js mounts it, for a given account.
function chatApp(identity) {
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use(
    "/chat",
    (req, _res, next) => {
      req.owner = identity;
      next();
    },
    createPublicAiBudgetContext({ reserve: async () => "reservation", refund: async () => true }),
    chatRouter,
  );
  return app;
}

// Claude answers; any other outgoing call (a planner, a tool) is kept apart
// and answered with an error. The plans service and the log are watched.
function stubClaude(t) {
  const calls = [];
  const others = [];
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    if (String(url) !== "https://api.anthropic.com/v1/messages") {
      others.push(String(url));
      return Response.json({ error: "not in this test" }, { status: 500 });
    }
    const body = JSON.parse(options.body || "{}");
    calls.push(body);
    return Response.json({
      model: body.model,
      content: [{ type: "text", text: "Работят календарът, картите и интернет търсенето." }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 10 },
    });
  });
  const plans = getProductPlansService();
  t.mock.method(plans, "useFreeChat", async () => false);
  t.mock.method(plans, "usage", async () => ({ remaining: 10_000 }));
  const lines = [];
  for (const method of ["log", "info"]) {
    const original = console[method];
    t.mock.method(console, method, (...args) => {
      lines.push(args.join(" "));
      original.apply(console, args);
    });
  }
  return { calls, others, lines };
}

const lastUserText = (body) => {
  const { content } = body.messages.at(-1);
  return typeof content === "string" ? content : content.map(({ text }) => text).join("");
};


test("the 22:21 question reaches the model with the tool list, for the owner and a member, in chat and Work mode", async (t) => {
  const claude = stubClaude(t);
  for (const identity of [owner, member]) {
    for (const mode of ["chat", "work"]) {
      const sessionId = `inventory-${identity.role}-${mode}`;
      const response = await request(chatApp(identity))
        .post("/chat/chat")
        .send({
          sessionId,
          message: QUESTION,
          mode,
          ...(mode === "work" ? { workContext: { project: { name: "Реклама" }, agent: { name: "NovariumAI" } } } : {}),
        })
        .expect(200);
      assert.match(response.text, /event: done/u);
      const body = claude.calls.at(-1);
      // The same list the route's checks give for this account and request.
      const expected = toolInventorySection(
        buildToolInventory({
          identity,
          connections: { google: null, githubSessionId: "" },
          mode,
          media: mediaAvailability(process.env, { member: identity.role !== "owner" }),
        }),
      );
      assert.equal(sectionOf(body.system), expected, `${identity.role} ${mode}`);
      assert.ok(expected.includes("\nКарти — „Намери кафене наблизо“\n"));
      assert.ok(expected.includes("\nКалендар, Контакти, Gmail, Google Drive, YouTube канал — „Свържи Google“\n"));
      assert.equal(expected.includes("GitHub"), identity.role === "owner");
      // No tool ran: the question itself reached the model.
      assert.equal(lastUserText(body), QUESTION);
      assert.ok(
        claude.lines.some((line) => line === `[Chat] Detected 0 capability subtasks for ${sessionId}: `),
        claude.lines.filter((line) => line.includes("Detected")).join("\n"),
      );
    }
  }
  assert.equal(claude.calls.length, 4);
  assert.deepEqual(claude.others, []);
});

test("a member's own Google connection shows in the list; another account's does not", async (t) => {
  const claude = stubClaude(t);
  const tokens = { access_token: "stand-in", expires_in: 3600, scope: GOOGLE_MEMBER_SCOPES.join(" ") };
  const own = await createSession(tokens, member);
  const others = await createSession(tokens, { ...member, memoryOwnerId: "identity-platform:someone-else" });
  for (const [cookie, connected] of [
    [own, true],
    [others, false],
  ]) {
    await request(chatApp(member))
      .post("/chat/chat")
      .set("Cookie", `synchron_google_session=${cookie}`)
      .send({ sessionId: `inventory-google-${connected}`, message: "Какво можеш?" })
      .expect(200);
    const section = sectionOf(claude.calls.at(-1).system);
    if (connected) {
      assert.ok(section.includes("\nКалендар — „Програмата ми за утре“\n"), section);
      assert.ok(section.includes("\nGmail — „Изпрати имейл до адрес | тема | текст“\n"), section);
      assert.ok(section.includes("\nGmail писма — „Разреши Gmail“\n"), section);
      assert.doesNotMatch(section, /„Свържи Google“/u);
    } else {
      assert.ok(section.includes("\nКалендар, Контакти, Gmail, Google Drive, YouTube канал — „Свържи Google“\n"), section);
      assert.doesNotMatch(section, /Календар — /u);
    }
    assert.doesNotMatch(section, /GitHub|Google Cloud/u);
  }
  assert.deepEqual(claude.others, []);
});

test("an English page gets the list in English", async (t) => {
  const claude = stubClaude(t);
  await request(chatApp(member))
    .post("/chat/chat")
    .send({ sessionId: "inventory-english", message: "What tools can you use?", language: "en" })
    .expect(200);
  const { system } = claude.calls.at(-1);
  const section = sectionOf(system);
  assert.ok(section.startsWith(`${TOOL_INVENTORY_HEADING} Checked at this request: site settings and this account's connections.\nWorking:\n`));
  assert.ok(section.includes("\nMaps — “Find a cafe near me”\n"), section);
  assert.ok(section.includes("\nNeed connecting:\nCalendar, Contacts, Gmail, Google Drive, YouTube channel — “Connect Google”\n"));
  assert.ok(section.endsWith("Results only from this request; writes (memory), sending and publishing only with the exact confirmation."));
  assert.ok(system.endsWith(replyLanguageRule("en")));
  assert.ok(claude.lines.includes("[Chat] Detected 0 capability subtasks for inventory-english: "));
  assert.deepEqual(claude.others, []);
});
