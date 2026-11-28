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
  parseContactSearchQuery,
  replyLanguageRule,
  stepNeedsPlanner,
  withoutUnaskedGitHubWrites,
} = await import("../src/routes/chat.js");
const { isReadOnlyIntegrationStatusRequest } = await import("../src/services/agentPlannerService.js");
const { routeSelectedWorkAgentCapabilities } = await import("../src/services/workModeService.js");
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
  resetGoogleSessionsForTests,
} = await import("../src/services/googleDriveService.js");
const { extractPersistentMemoryCommands } = await import("../src/services/memoryService.js");
const { createPublicAiBudgetContext } = await import("../src/services/publicAiBudget.js");
const { getProductPlansService } = await import("../src/services/productPlansService.js");
const { setFirestoreTaskRunStoreForTests } = await import("../src/services/taskRunService.js");

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
      ["todos", "ready"],
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
  // Review r6: the owner's chat reads the work drafts, and „Моите задачи“ is
  // another list, so both are named for what they are.
  assert.equal(byId(entries, "tasks").label, "Работни задачи");
  assert.equal(byId(entries, "todos").label, "Моите задачи");
});

test("a member after the first „Свържи Google“: calendar, contacts, sending and saving work; the rest name their own step", () => {
  const entries = buildToolInventory({ identity: member, env: siteEnv, connections: memberGoogle });
  assert.deepEqual(
    entries.map(({ id, status, press }) => [id, status, press]),
    [
      ["calendar", "ready", ""],
      ["contacts", "ready", ""],
      ["gmail", "ready", ""],
      ["gmail-read", "connect", "„Покажи писмата в Gmail“, после „Разреши Gmail“ в отговора"],
      ["drive", "ready", ""],
      ["drive-read", "connect", "„Покажи Google Drive“, после „Разреши Google Drive“ в отговора"],
      ["youtube", "connect", "„Покажи моя YouTube канал“, после „Свържи YouTube“ в отговора"],
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
    example: "„Изпрати имейл до адрес | тема | текст“ (до мен — до теб)",
    confirm: "имейли",
    press: "",
  });
  assert.equal(byId(entries, "drive").example, "бутон „Запази в Google“");
  assert.equal(byId(entries, "calendar").confirm, "събития");
  assert.equal(byId(entries, "contacts").confirm, "контакти");
});

test("without a Google connection „Свържи Google“ names what its first press turns on; YouTube names its second step", () => {
  // Review r6: the first press grants calendar, contacts, sending and saving
  // (GOOGLE_MEMBER_SCOPES, the owner too); YouTube is turned on from an
  // answer after it.
  for (const identity of [owner, member]) {
    const entries = buildToolInventory({ identity, env: siteEnv, connections: {} });
    for (const id of ["calendar", "contacts", "gmail", "drive", "youtube"]) {
      assert.equal(byId(entries, id).status, "connect", `${identity.role} ${id}`);
      assert.equal(byId(entries, id).press, id === "youtube" ? "„Свържи Google“, после „Покажи моя YouTube канал“ и „Свържи YouTube“ в отговора" : "„Свържи Google“");
      assert.equal(byId(entries, id).confirm, "");
    }
    assert.equal(byId(entries, "gmail").label, "Gmail (изпращане)");
    assert.equal(byId(entries, "drive").label, "Google Drive (запазване)");
    // The tools that need no Google still work.
    for (const id of ["youtube-video", "places", "web", "media", "memory", "files", "claude"]) {
      assert.equal(byId(entries, id).status, "ready", `${identity.role} ${id}`);
    }
    const section = toolInventorySection(entries);
    assert.ok(
      section.includes("\nИскат свързване:\nКалендар, Контакти, Gmail (изпращане), Google Drive (запазване) — „Свържи Google“\nYouTube канал — „Свържи Google“, после „Покажи моя YouTube канал“ и „Свържи YouTube“ в отговора\n"),
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
      ["gmail", "„Покажи писмата в Gmail“, после „Разреши Gmail“ в отговора"],
      ["drive-read", "„Покажи Google Drive“, после „Разреши Google Drive“ в отговора"],
      ["youtube", "„Покажи моя YouTube канал“, после „Свържи YouTube“ в отговора"],
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
  assert.equal(byId(extended, "gmail").example, "„Покажи писмата в Gmail“; „Изпрати имейл до адрес | тема | текст“ (до мен — до теб)");
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
  // Review r6: with nothing working, the list never says it has tools.
  assert.doesNotMatch(bare, /Не казвай, че нямаш инструменти|Системата пуска/u);
  const bareEnglish = toolInventorySection(buildToolInventory({ identity: member, env: { NODE_ENV: "production" }, language: "en" }), {
    language: "en",
  });
  assert.doesNotMatch(bareEnglish, /Never say you have no tools|The system runs tools/u);
  assert.match(bareEnglish, /\nWorking: none right now\.\n/u);
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

test("the section stays within 1,800 characters with every example, for every account and page", () => {
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
  assert.ok(longest > 1500, `the longest list was measured: ${longest}`);
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
  "Календар — „Програмата ми за утре“; „Създай събитие: заглавие | ГГГГ-ММ-ДД ЧЧ:ММ | минути“",
  "Контакти — „Намери в контактите Иван“; „Добави контакт: име | имейл | телефон“",
  "Gmail — „Покажи писмата в Gmail“; „Изпрати имейл до адрес | тема | текст“ (до мен — до теб)",
  "Google Drive — „Покажи Google Drive“; бутон „Запази в Google“",
  "YouTube канал — „Покажи моя YouTube канал“",
  "YouTube видео — резюме по линк",
  "Карти — „Намери кафене наблизо“",
  "Интернет — „Потърси в интернет …“",
  "Картинки и видео — опиши ги; „да“ ги прави",
  "Работни задачи — „Покажи работните задачи“",
  "Моите задачи — „Моите задачи“; „Добави задача да се обадя на банката утре“",
  "Памет — „Запомни: …“",
  "Моите файлове — питай за качен файл",
  "Работа с Claude — в „Добавки“",
  "GitHub — „Последният commit в GitHub“",
  "Google Cloud — „Провери Google Cloud“",
  "Питат ли какво можеш, изброй работещите с пример, после чакащите свързване.",
  "Системата пуска инструмента преди отговора ти; резултатът идва в [РЕЗУЛТАТИ ОТ ИНСТРУМЕНТИ]. Без него кажи кой става и точните думи или ги дай в „Следва:“ („да“ пуска четене, а имейл, контакт или събитие с всички данни подготвя за бутона „Потвърди“). Не казвай, че нямаш инструменти.",
  "Резултати — само от тази заявка; записи (събития, контакти, имейли, памет, GitHub, Google Cloud), изпращане и публикуване — само с точното потвърждение.",
].join("\n");
const MEMBER_SECTION = [
  "[ТВОИТЕ ИНСТРУМЕНТИ СЕГА] Проверени при тази заявка: настройки на сайта и връзките на този акаунт.",
  "Работят:",
  "YouTube видео — резюме по линк",
  "Карти — „Намери кафене наблизо“",
  "Интернет — „Потърси в интернет …“",
  "Картинки и видео — опиши ги; „да“ ги прави",
  "Моите задачи — „Моите задачи“; „Добави задача да се обадя на банката утре“",
  "Памет — „Запомни: …“",
  "Моите файлове — питай за качен файл",
  "Работа с Claude — в „Добавки“",
  "Искат свързване:",
  "Календар, Контакти, Gmail (изпращане), Google Drive (запазване) — „Свържи Google“",
  "YouTube канал — „Свържи Google“, после „Покажи моя YouTube канал“ и „Свържи YouTube“ в отговора",
  "Питат ли какво можеш, изброй работещите с пример, после чакащите свързване.",
  "Системата пуска инструмента преди отговора ти; резултатът идва в [РЕЗУЛТАТИ ОТ ИНСТРУМЕНТИ]. Без него кажи кой става и точните думи или ги дай в „Следва:“ („да“ пуска четене, а имейл, контакт или събитие с всички данни подготвя за бутона „Потвърди“). Не казвай, че нямаш инструменти.",
  "Резултати — само от тази заявка; записи (памет), изпращане и публикуване — само с точното потвърждение.",
].join("\n");
const ENGLISH_MEMBER_SECTION = [
  "[ТВОИТЕ ИНСТРУМЕНТИ СЕГА] Checked at this request: site settings and this account's connections.",
  "Working:",
  "Calendar — “My calendar tomorrow”; “Create a calendar event: title | YYYY-MM-DD HH:MM | minutes”",
  "Contacts — “Search contacts for Ivan”; “Add a contact: name | email | phone”",
  "Gmail — “Send an email to address | subject | text” (to me — to you)",
  "Google Drive — “Save to Google” button",
  "YouTube videos — summary by link",
  "Maps — “Find a cafe near me”",
  "Web — “Do a web search for …”",
  "Pictures and video — describe; “yes” makes them",
  "My tasks — “My tasks”; “Add a task: call the bank tomorrow”",
  "Memory — “Запомни: …”",
  "My files — ask about an added file",
  "Work with Claude — in “Add-ons”",
  "Need connecting:",
  "Reading Gmail — “Show my Gmail”, then “Allow Gmail” in the answer",
  "Reading Drive — “Show my Google Drive files”, then “Allow Google Drive” in the answer",
  "YouTube channel — “Show my YouTube channel”, then “Allow YouTube” in the answer",
  "Asked what you can do: the working tools with an example, then those to connect.",
  "The system runs tools before your answer; results come in [TOOL RESULTS]. Without one, name the fitting tool and its exact words, or put them in “Next:” (“yes” runs a read, and prepares an email, contact or event with all its fields for the “Confirm” button). Never say you have no tools.",
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
  assert.ok(bulgarian.includes("\nИскат свързване:\nКалендар, Контакти, Gmail (изпращане), Google Drive (запазване) — „Свържи Google“\nYouTube канал — „Свържи Google“, после „Покажи моя YouTube канал“ и „Свържи YouTube“ в отговора\n"), bulgarian);
  for (const language of ["en", "de", "fr", "es"]) {
    const page = labels(language);
    assert.equal(page, labels("en"), language);
    assert.ok(page.startsWith(`${TOOL_INVENTORY_HEADING} Checked at this request: site settings and this account's connections.\n`));
    assert.match(page, /\nWorking:\n/u);
    assert.ok(page.includes("\nNeed connecting:\nCalendar, Contacts, Gmail (sending), Google Drive (saving) — “Connect Google”\nYouTube channel — “Connect Google”, then “Show my YouTube channel” and “Allow YouTube” in the answer\n"), page);
    assert.match(page, /\nGitHub — “Latest commit on GitHub”\n/u);
    // Only the work-task and memory commands are Bulgarian words: the chat
    // runs them only so.
    const bulgarianWords = page.split("\n").slice(1).join("\n").match(/[А-Яа-я][^“”\n]*/gu) || [];
    assert.deepEqual(bulgarianWords, ["Покажи работните задачи", "Запомни: …"], page);
  }
  // The same for each entry's own words.
  const english = buildToolInventory({ identity: owner, env: siteEnv, connections: ownerGoogle, language: "en" });
  assert.equal(byId(english, "calendar").label, "Calendar");
  assert.equal(byId(english, "calendar").confirm, "events");
  assert.equal(byId(english, "tasks").example, "“Покажи работните задачи”");
  assert.equal(byId(english, "todos").example, "“My tasks”; “Add a task: call the bank tomorrow”");
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
    todos: "todos.read",
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
    // Review r6: more ways to ask the same, also in capitals.
    "Имаш ли инструменти?",
    "А имаш ли някакви инструменти?",
    "ИМАШ ЛИ ИНСТРУМЕНТИ",
    "Кои инструменти са ти достъпни сега?",
    "Какви инструменти са ти достъпни?",
    "КОИ ИНСТРУМЕНТИ СА ТИ ДОСТЪПНИ",
    "Изброй инструментите, които можеш да ползваш",
    "Изброй инструментите си",
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
    // Review r6: a check asked after a list question in one sentence.
    "Кои инструменти можеш да ползваш и провери дали работят",
    "КОИ ИНСТРУМЕНТИ МОЖЕШ ДА ПОЛЗВАШ И ПРОВЕРИ ДАЛИ РАБОТЯТ",
    "Кои инструменти можеш да ползваш, провери ги",
    "Достъпни ли са инструментите?",
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

test("a greeting or a thanks around a question about the tools prepares no GitHub change", () => {
  // Review r6 (inventory-1): these prepared a change, with four advisor calls
  // of about 494,000 characters each.
  const site = (message) => detectCapabilityRequests(message, { toolInventory: true }).map(({ capability }) => capability);
  for (const question of [
    "Здравей! С кои инструменти можеш да промениш кода в GitHub?",
    "С кои инструменти можеш да промениш кода в GitHub? Благодаря.",
    "Добре. А с кои инструменти можеш да промениш кода в GitHub?",
    "Какви инструменти имаш за промени в GitHub? Интересно ми е.",
    "ЗДРАВЕЙ! С КОИ ИНСТРУМЕНТИ МОЖЕШ ДА ПРОМЕНИШ КОДА В GITHUB",
  ]) {
    assert.equal(site(question).includes("code.write"), false, question);
    assert.equal(isToolInventoryMessage(question), true, question);
    // The planner's change is dropped too.
    assert.deepEqual(
      withoutUnaskedGitHubWrites([{ capability: "code.read" }, { capability: "code.write" }], question),
      [{ capability: "code.read" }],
      question,
    );
  }
  // A change asked for next to the question is prepared, also when only the
  // question names GitHub.
  for (const change of [
    "Кои инструменти можеш да ползваш? Промени README в GitHub",
    "Кои инструменти ползваш за GitHub? Промени README.",
    "С кои инструменти можеш да работиш в GitHub? Обнови README.",
  ]) {
    assert.equal(site(change).includes("code.write"), true, change);
    assert.deepEqual(withoutUnaskedGitHubWrites([{ capability: "code.write" }], change), [{ capability: "code.write" }], change);
  }
  // Any other message keeps what the planner planned.
  assert.deepEqual(withoutUnaskedGitHubWrites([{ capability: "code.write" }], "Поправи бъга в чата"), [{ capability: "code.write" }]);
  assert.deepEqual(
    withoutUnaskedGitHubWrites([{ capability: "github.pull-request.merge" }], "Какво можеш?"),
    [],
  );
});

test("the code agent analyses no code for a question about the tools", () => {
  // Review r6 (inventory-8): „С кои инструменти можеш да работиш?“ ran a code
  // analysis of about 467,000 characters for the „Код“ agent.
  const code = { agent: { name: "Код", engine: "codex", model: "auto" }, project: { name: "NovariumAI" } };
  const analysis = [{ capability: "code.analyze", message: "x" }];
  for (const question of ["С кои инструменти можеш да работиш?", "Здравей! С кои инструменти можеш да работиш?", "what tools can you use"]) {
    assert.deepEqual(
      routeSelectedWorkAgentCapabilities(analysis, code, question, { toolQuestion: isToolInventoryMessage(question) }),
      [],
      question,
    );
  }
  // A real task keeps its analysis.
  for (const task of ["Използвай инструментите и анализирай кода", "ИЗПОЛЗВАИ ИНСТРУМЕНТИТЕ И ОПРАВИ ГРЕШКАТА В CHAT.JS"]) {
    assert.equal(isToolInventoryMessage(task), false, task);
  }
});

// Item 3, fix 4 (Team 2's live probes 28.11): the name before „в
// контактите“, without the article Google's name search would not find.
test("a contact search in his own words finds the name before „в контактите“", () => {
  for (const [message, query] of [
    ["намери ми телефона на счетоводителя в контактите", "счетоводител"],
    ["потърси иван в контактите ми", "иван"],
    ["покажи ми номера на банката от контактите", "банка"],
    ["имаш ли телефона на мама в контактите", "мама"],
    ["намери ми мобилния на Петър Иванов в контактите", "Петър Иванов"],
    ["потърси Мария Петрова в контактите ми", "Мария Петрова"],
    ["find John in my contacts", "John"],
    ["what is the phone number of Ana in my contacts", "Ana"],
  ]) {
    assert.equal(parseContactSearchQuery(message), query, message);
    assert.deepEqual(
      detectCapabilityRequests(message).map(({ capability, message: text }) => [capability, text]),
      [["contacts.read", query]],
      message,
    );
  }
  // No name: nothing to search for.
  for (const message of ["намери ми контакта", "Намери в контактите", "Покажи контактите ми", "колко контакта имам", "Свържи контактите"]) {
    assert.equal(parseContactSearchQuery(message), "", message);
  }
});

test("a contact search drops the quotes and the end punctuation of a quoted example", () => {
  // Review r6 (inventory-7): a yes to „пускам „Намери в контактите Иван““
  // sent „Иван“ with its closing quote, and Google found no one.
  for (const [message, query] of [
    ["Намери в контактите Иван“.", "Иван"],
    ["Намери в контактите „Иван“", "Иван"],
    ["Намери в контактите Иван.“", "Иван"],
    ["Search contacts for Ivan”", "Ivan"],
    ["Намери в контактите Иван", "Иван"],
    ["Намери в контактите Мария Петрова?", "Мария Петрова"],
  ]) {
    assert.equal(parseContactSearchQuery(message), query, message);
  }
  const taskMessage = buildContextualTaskMessage("да", [
    { role: "user", content: "Какво можеш?" },
    { role: "assistant", content: "Мога да търся в контактите.\n\nСледва: напиши „да“ и пускам „Намери в контактите Иван“." },
  ]);
  const contacts = detectCapabilityRequests(taskMessage, { toolInventory: true }).filter(
    ({ capability }) => capability === "contacts.read",
  );
  assert.deepEqual(contacts.map(({ message }) => message), ["Иван"]);
});

test("a request to show the calendar runs it, also with „ако работи“; a status question stays a check", () => {
  // Review r6 (inventory-10).
  for (const message of [
    "Използвай инструментите, с които работиш, и покажи календара ми",
    "Покажи календара ми, ако работи",
    "Покажи календара ми, ако е свързан",
  ]) {
    assert.equal(isReadOnlyIntegrationStatusRequest(message), false, message);
  }
  for (const message of ["Покажи статуса на календара", "Покажи дали календарът работи", "Работи ли календарът?"]) {
    assert.equal(isReadOnlyIntegrationStatusRequest(message), true, message);
  }
  assert.deepEqual(
    detectCapabilityRequests("Използвай инструментите, с които работиш, и покажи календара ми", { toolInventory: true }).map(
      ({ capability }) => capability,
    ),
    ["calendar.read"],
  );
});

test("a step that names a tool by its name starts no status check", () => {
  // Review r6 (inventory-4): „…използвам инструмента Календар…“ added the
  // technical status check to the calendar.
  const taskMessage = buildContextualTaskMessage("да", [
    { role: "user", content: "Какво можеш?" },
    { role: "assistant", content: "Календарът работи.\n\nСледва: напиши „да“ и използвам инструмента Календар за утре." },
  ]);
  assert.deepEqual(
    detectCapabilityRequests(taskMessage, { toolInventory: true }).map(({ capability }) => capability),
    ["calendar.read"],
  );
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
// `answer(url, options)` may stand in for one other service (a Gmail send,
// the plain-words reader); every call to another service is still recorded in
// `others`.
function stubClaude(t, { answer } = {}) {
  const calls = [];
  const others = [];
  const otherBodies = [];
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    if (String(url) !== "https://api.anthropic.com/v1/messages") {
      others.push(String(url));
      otherBodies.push(typeof options.body === "string" ? options.body : "");
      const answered = answer ? await answer(String(url), options) : undefined;
      return answered || Response.json({ error: "not in this test" }, { status: 500 });
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
  return { calls, others, otherBodies, lines };
}

const lastUserText = (body) => {
  const { content } = body.messages.at(-1);
  return typeof content === "string" ? content : content.map(({ text }) => text).join("");
};


test("the 22:21 question reaches the model with the tool list, for the owner and a member, in chat and Work mode", async (t) => {
  // No Google connection is stored for either account.
  resetGoogleSessionsForTests();
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
      assert.ok(expected.includes("\nКалендар, Контакти, Gmail (изпращане), Google Drive (запазване) — „Свържи Google“\nYouTube канал — „Свържи Google“, после „Покажи моя YouTube канал“ и „Свържи YouTube“ в отговора\n"));
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
  resetGoogleSessionsForTests();
  const claude = stubClaude(t);
  const tokens = { access_token: "stand-in", expires_in: 3600, scope: GOOGLE_MEMBER_SCOPES.join(" ") };
  const others = await createSession(tokens, { ...member, memoryOwnerId: "identity-platform:someone-else" });
  // Someone else's cookie, before and after the member's own connection:
  // only the member's own one is ever used, also without its cookie (it
  // follows the account to another browser and the other name of the site).
  for (const [cookie, connected] of [
    [others, false],
    [null, true],
    [others, true],
  ]) {
    if (cookie === null) await createSession(tokens, member);
    const call = request(chatApp(member)).post("/chat/chat");
    if (cookie) call.set("Cookie", `synchron_google_session=${cookie}`);
    await call.send({ sessionId: `inventory-google-${connected}-${Boolean(cookie)}`, message: "Какво можеш?" }).expect(200);
    const section = sectionOf(claude.calls.at(-1).system);
    if (connected) {
      assert.ok(section.includes("\nКалендар — „Програмата ми за утре“; „Създай събитие: заглавие | ГГГГ-ММ-ДД ЧЧ:ММ | минути“\n"), section);
      assert.ok(section.includes("\nGmail — „Изпрати имейл до адрес | тема | текст“ (до мен — до теб)\n"), section);
      assert.ok(section.includes("\nGmail писма — „Покажи писмата в Gmail“, после „Разреши Gmail“ в отговора\n"), section);
      assert.doesNotMatch(section, /„Свържи Google“/u);
    } else {
      assert.ok(section.includes("\nКалендар, Контакти, Gmail (изпращане), Google Drive (запазване) — „Свържи Google“\nYouTube канал — „Свържи Google“, после „Покажи моя YouTube канал“ и „Свържи YouTube“ в отговора\n"), section);
      assert.doesNotMatch(section, /Календар — /u);
    }
    assert.doesNotMatch(section, /GitHub|Google Cloud/u);
  }
  assert.deepEqual(claude.others, []);
});

test("an English page gets the list in English", async (t) => {
  resetGoogleSessionsForTests();
  const claude = stubClaude(t);
  await request(chatApp(member))
    .post("/chat/chat")
    .send({ sessionId: "inventory-english", message: "What tools can you use?", language: "en" })
    .expect(200);
  const { system } = claude.calls.at(-1);
  const section = sectionOf(system);
  assert.ok(section.startsWith(`${TOOL_INVENTORY_HEADING} Checked at this request: site settings and this account's connections.\nWorking:\n`));
  assert.ok(section.includes("\nMaps — “Find a cafe near me”\n"), section);
  assert.ok(section.includes("\nNeed connecting:\nCalendar, Contacts, Gmail (sending), Google Drive (saving) — “Connect Google”\nYouTube channel — “Connect Google”, then “Show my YouTube channel” and “Allow YouTube” in the answer\n"), section);
  assert.ok(section.endsWith("Results only from this request; writes (memory), sending and publishing only with the exact confirmation."));
  assert.ok(system.endsWith(replyLanguageRule("en")));
  assert.ok(claude.lines.includes("[Chat] Detected 0 capability subtasks for inventory-english: "));
  assert.deepEqual(claude.others, []);
});

// ── A short yes runs only the step the answer proposed (review r5) ────────

// The chat route with a watched units budget: each reservation's units and
// provider.
function watchedChatApp(identity, reserved) {
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use(
    "/chat",
    (req, _res, next) => {
      req.owner = identity;
      next();
    },
    createPublicAiBudgetContext({
      reserve: async (_identity, credits, details) => {
        reserved.push({ credits, provider: details?.provider || "" });
        return "reservation";
      },
      refund: async () => true,
    }),
    chatRouter,
  );
  return app;
}

const detectedLine = (claude, sessionId) =>
  claude.lines.find((line) => line.startsWith(`[Chat] Detected `) && line.includes(` for ${sessionId}: `)) || "";

test("a short yes after an answer with no Next line runs no tool and no planner, for the owner and a member", async (t) => {
  const claude = stubClaude(t);
  const list = [
    "Работят:",
    "Календар — „Програмата ми за утре“",
    "Gmail — „Покажи писмата в Gmail“",
    "Карти — „Намери кафене наблизо“",
    "Интернет — „Потърси в интернет новини за Пловдив“",
    "GitHub — „Последният commit в GitHub“",
    "Google Cloud — „Провери Google Cloud“",
  ].join("\n");
  let run = 0;
  for (const identity of [owner, member]) {
    for (const yes of ["ok", "Добре", "ДА", "yes", "супер, давай"]) {
      const reserved = [];
      run += 1;
      const sessionId = `no-step-${run}`;
      await request(watchedChatApp(identity, reserved))
        .post("/chat/chat")
        .send({
          sessionId,
          message: yes,
          recentHistory: [
            { role: "user", content: QUESTION },
            { role: "assistant", content: list },
          ],
        })
        .expect(200);
      assert.equal(detectedLine(claude, sessionId), `[Chat] Detected 0 capability subtasks for ${sessionId}: `, yes);
      // A member pays for the reply alone.
      if (identity === member) assert.deepEqual(reserved.map(({ provider }) => provider), ["claude"], yes);
    }
  }
  // No planner and no tool was called.
  assert.deepEqual(claude.others, []);
});

test("a yes to the step runs that step's tool alone, not the request before it", async (t) => {
  const claude = stubClaude(t);
  let run = 0;
  for (const [request_, step, expected] of [
    ["Намери кафене наблизо", "напиши „да“ и пускам „Потърси в интернет новини за Пловдив“.", "#1:web.search"],
    ["Покажи писмата в Gmail", "напиши „да“ и пускам „Програмата ми за утре“.", "#1:calendar.read"],
    // The status check does not start from the words „използвам инструмента“.
    ["Какво можеш?", "напиши „да“ и използвам инструмента Календар: „Програмата ми за утре“.", "#1:calendar.read"],
  ]) {
    for (const yes of ["да", "ДА ДАВАЙ", "yes"]) {
      run += 1;
      const sessionId = `step-only-${run}`;
      await request(chatApp(owner))
        .post("/chat/chat")
        .send({
          sessionId,
          message: yes,
          recentHistory: [
            { role: "user", content: request_ },
            { role: "assistant", content: `Готово.\n\nСледва: ${step}` },
          ],
        })
        .expect(200);
      assert.equal(detectedLine(claude, sessionId), `[Chat] Detected 1 capability subtasks for ${sessionId}: ${expected}`, `${request_} / ${yes}`);
    }
  }
});

test("a member's yes to a search step after a maps request pays for the search only", async (t) => {
  const claude = stubClaude(t);
  const reserved = [];
  const sessionId = "member-yes-web";
  await request(watchedChatApp(member, reserved))
    .post("/chat/chat")
    .send({
      sessionId,
      message: "да",
      recentHistory: [
        { role: "user", content: "Намери кафене наблизо" },
        { role: "assistant", content: "Ето три кафенета.\n\nСледва: напиши „да“ и пускам „Потърси в интернет новини за Пловдив“." },
      ],
    })
    .expect(200);
  assert.equal(detectedLine(claude, sessionId), `[Chat] Detected 1 capability subtasks for ${sessionId}: #1:web.search`);
  // No Google Maps search, and no Maps units.
  assert.ok(!claude.others.some((url) => url.includes("generativelanguage.googleapis.com")), claude.others.join("\n"));
  assert.ok(!reserved.some(({ provider }) => provider === "gemini"), JSON.stringify(reserved));
});

test("a yes to a step with tool words that the detector cannot read goes to the planner; a step without any does not", async (t) => {
  const claude = stubClaude(t);
  // The planner's calls; the plain-words reader's own call is not one.
  const planned = () =>
    claude.others.filter(
      (url, index) => url.startsWith("https://api.openai.com/") && !claude.otherBodies[index].includes("novarium_plain_intent"),
    ).length;
  let before = 0;
  for (const [step, planner] of [
    ["кажи „да“ и проверявам пощата ти за писма от застрахователя.", true],
    ["say yes and I will check your calendar for tomorrow.", true],
    ["кажи „да“ и търся в интернет цените на билетите.", true],
    ["кажи дали видеото да е вертикално за телефон.", false],
    ["кажи „да“ и пиша по-кратък вариант на текста.", false],
  ]) {
    const sessionId = `planner-${step.length}`;
    await request(chatApp(owner))
      .post("/chat/chat")
      .send({
        sessionId,
        message: "да",
        recentHistory: [
          { role: "user", content: "Какво следва?" },
          { role: "assistant", content: `Готово.\n\nСледва: ${step}` },
        ],
      })
      .expect(200);
    const now = planned();
    assert.equal(now > before, planner, step);
    before = now;
  }
  assert.equal(stepNeedsPlanner("кажи дали видеото да е вертикално"), false);
  assert.equal(stepNeedsPlanner("правя двете картинки"), false);
  assert.equal(stepNeedsPlanner("проверявам пощата ти"), true);
  assert.equal(stepNeedsPlanner("I will check your calendar"), true);
});

// RADKO 28.11 on the live site: „искам да пратя мейл до мен“ got „нямам
// проверен инструмент за изпращане на поща“, with Gmail connected. Now the
// agent writes the exact email as its step, and „да“ sends it to the
// person's own address at once: the command is the confirmation (RADKO
// 28.11 04:29, „без излишни бутони и потвърждения“). One send, no button.
test("a yes to the agent's exact email „до мен“ sends it to the person's own Gmail at once, with no button", async (t) => {
  const sends = [];
  const claude = stubClaude(t, {
    answer: (url, options) => {
      if (url !== "https://gmail.googleapis.com/gmail/v1/users/me/messages/send") return undefined;
      sends.push(JSON.parse(options.body || "{}"));
      return Response.json({ id: "sent-1", threadId: "thread-1" });
    },
  });
  const claims = Buffer.from(JSON.stringify({ sub: "m-1", email: "ana@example.com", email_verified: true })).toString("base64url");
  const cookie = await createSession(
    { access_token: "stand-in", expires_in: 3600, scope: GOOGLE_MEMBER_SCOPES.join(" "), id_token: `e30.${claims}.signature` },
    member,
  );
  const sessionId = "yes-email-to-me";
  const response = await request(chatApp(member))
    .post("/chat/chat")
    .set("Cookie", `synchron_google_session=${cookie}`)
    .send({
      sessionId,
      message: "да",
      recentHistory: [
        { role: "user", content: "ISKAM DA PATI MEIL DO MEN" },
        { role: "assistant", content: "Мога да го пратя от твоя Gmail.\n\nСледва: Изпрати имейл до мен | Проба от NovariumAI | Здравей! Това е проба." },
      ],
    })
    .expect(200);
  assert.equal(detectedLine(claude, sessionId), `[Chat] Detected 1 capability subtasks for ${sessionId}: #1:mail.send`);
  assert.match(response.text, /Имейлът е изпратен до ana@example\.com\./u);
  assert.match(response.text, /Проба от NovariumAI/u);
  assert.doesNotMatch(response.text, /Потвърждавам NovariumAI задача/u);
  // Exactly one email, to the person's own address, with the agent's words.
  assert.equal(sends.length, 1);
  const mime = Buffer.from(sends[0].raw, "base64url").toString("utf8");
  assert.match(mime, /^To: ana@example\.com\r\n/u);
  assert.match(mime, /Здравей! Това е проба\./u);
});

// Item 3, fix 1 (RADKO 28.11 05:26–05:41): mail in his own words on the site
// chat. The reader (OpenAI, stubbed here) returns the fields; an email to the
// person goes at once, a missing detail is one question, and the mailbox is
// read with the reader's search words.
const READER_URL = "https://api.openai.com/v1/responses";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const plainIntent = (fields = {}) => ({
  action: "mail.send",
  recipient: "",
  recipientName: "",
  subject: "",
  body: "",
  title: "",
  date: "",
  time: "",
  query: "",
  contactName: "",
  contactEmail: "",
  contactPhone: "",
  taskText: "",
  taskDate: "",
  picture: "",
  durationMinutes: 0,
  ...fields,
});

// The reader answers `intents` in turn; Gmail answers sends and reads.
function mailServices(t, { intents = [], inbox = [], search = null, readStatus = 200 } = {}) {
  const sends = [];
  const readerCalls = [];
  const gmailReads = [];
  const claude = stubClaude(t, {
    answer: (url, options) => {
      if (url === READER_URL) {
        const body = JSON.parse(options.body || "{}");
        if (body.text?.format?.name !== "novarium_plain_intent") return undefined;
        readerCalls.push(body);
        const intent = intents[readerCalls.length - 1] || plainIntent({ action: "none" });
        return Response.json({ output_text: JSON.stringify(intent) });
      }
      if (url === `${GMAIL}/messages/send`) {
        sends.push(JSON.parse(options.body || "{}"));
        return Response.json({ id: `sent-${sends.length}`, threadId: "thread-1" });
      }
      if (url.startsWith(`${GMAIL}/messages?`)) {
        gmailReads.push(new URL(url).searchParams.get("q"));
        if (readStatus !== 200) {
          return Response.json(
            { error: { status: "PERMISSION_DENIED", message: "Request had insufficient authentication scopes." } },
            { status: readStatus },
          );
        }
        const q = new URL(url).searchParams.get("q");
        const found = q === "in:anywhere" || search === null ? inbox : search;
        return Response.json({ messages: found.map(({ id }) => ({ id })) });
      }
      const detail = url.match(/\/messages\/([^/?]+)\?/u);
      if (url.startsWith(`${GMAIL}/messages/`) && detail) {
        const message = inbox.find(({ id }) => id === decodeURIComponent(detail[1]));
        if (!message) return undefined;
        return Response.json({
          id: message.id,
          labelIds: ["INBOX"],
          payload: {
            headers: [
              { name: "Subject", value: message.subject },
              { name: "From", value: message.from },
            ],
          },
        });
      }
      return undefined;
    },
  });
  const sentMime = () => sends.map(({ raw }) => Buffer.from(raw, "base64url").toString("utf8"));
  return { claude, sends, sentMime, readerCalls, gmailReads };
}

async function googleCookie(identity, scopes, email) {
  const claims = Buffer.from(JSON.stringify({ sub: `${identity.id}-sub`, email, email_verified: true })).toString("base64url");
  return createSession(
    { access_token: "stand-in", expires_in: 3600, scope: scopes.join(" "), id_token: `e30.${claims}.signature` },
    identity,
  );
}

test("„ПРАТИ МЕЛ ДА МИЯ … ЗДРАВЕ“ in his own words sends one email to his own address at once", async (t) => {
  const services = mailServices(t, {
    intents: [plainIntent({ recipient: "me", subject: "Здраве", body: "Тук при пост, здраве." })],
  });
  // The saved run of the task, as the „Задачи“ panel reads it.
  const runs = new Map();
  setFirestoreTaskRunStoreForTests({
    get: async (id) => (runs.has(id) ? { id, data: structuredClone(runs.get(id)) } : null),
    set: async (id, data) => void runs.set(id, structuredClone(data)),
    listByOwner: async () => [...runs].map(([id, data]) => ({ id, data: structuredClone(data) })),
  });
  t.after(() => setFirestoreTaskRunStoreForTests(null));
  const cookie = await googleCookie(member, GOOGLE_MEMBER_SCOPES, "ana@example.com");
  const response = await request(chatApp(member))
    .post("/chat/chat")
    .set("Cookie", `synchron_google_session=${cookie}`)
    .send({ sessionId: "plain-mail-self", message: "ПРАТИ МЕЛ ДА МИЯ ТУК ПРИ ПОСТ ЗДРАВЕ" })
    .expect(200);
  assert.equal(services.readerCalls.length, 1);
  assert.equal(services.sends.length, 1);
  const [mime] = services.sentMime();
  assert.match(mime, /^To: ana@example\.com\r\n/u);
  assert.match(mime, /Тук при пост, здраве\./u);
  assert.match(response.text, /Имейлът е изпратен до ana@example\.com\./u);
  assert.match(response.text, /Тема: Здраве/u);
  assert.match(response.text, /"mode":"own-command-write"/u);
  assert.doesNotMatch(response.text, /Потвърждавам NovariumAI задача/u);
  // No planner and no model answer on top of it.
  assert.deepEqual(services.claude.calls, []);
  // Done, not „чака потвърждение“ (Team 2's probe 28.11).
  assert.deepEqual([...runs.values()].map(({ status }) => status), ["completed"]);
});

test("„ISKAM DA PATI MEIL DO MEN“ asks what to write; his answer sends it", async (t) => {
  const services = mailServices(t, {
    intents: [
      plainIntent({ recipient: "me" }),
      plainIntent({ recipient: "me", subject: "Здраве", body: "Тук при пост, здраве." }),
    ],
  });
  const cookie = await googleCookie(member, GOOGLE_MEMBER_SCOPES, "ana@example.com");
  const asked = await request(chatApp(member))
    .post("/chat/chat")
    .set("Cookie", `synchron_google_session=${cookie}`)
    .send({ sessionId: "plain-mail-ask", message: "ISKAM DA PATI MEIL DO MEN" })
    .expect(200);
  const question = "Какво да пише в имейла? Напиши текста (и темата, ако искаш) и го пращам веднага.";
  assert.match(asked.text, new RegExp(question.replace(/[()?]/gu, "\\$&"), "u"));
  assert.match(asked.text, /"mode":"plain-words-ask"/u);
  assert.equal(services.sends.length, 0);

  const sent = await request(chatApp(member))
    .post("/chat/chat")
    .set("Cookie", `synchron_google_session=${cookie}`)
    .send({
      sessionId: "plain-mail-ask",
      message: "ТУК ПРИ ПОСТ ЗДРАВЕ",
      recentHistory: [
        { role: "user", content: "ISKAM DA PATI MEIL DO MEN" },
        { role: "assistant", content: question },
      ],
    })
    .expect(200);
  assert.equal(services.readerCalls.length, 2);
  assert.equal(services.sends.length, 1);
  assert.match(sent.text, /Имейлът е изпратен до ana@example\.com\./u);
});

test("an email to an address he did not type is never sent: the reader's address is asked for, the agent's keeps „Потвърди“", async (t) => {
  const services = mailServices(t, {
    intents: [plainIntent({ recipient: "ivan@example.com", recipientName: "Иван", body: "Здравей" })],
  });
  const cookie = await googleCookie(owner, GOOGLE_BASE_SCOPES, "radko@example.com");
  const asked = await request(chatApp(owner))
    .post("/chat/chat")
    .set("Cookie", `synchron_google_session=${cookie}`)
    .send({ sessionId: "plain-mail-untyped", message: "прати мейл на иван здравей" })
    .expect(200);
  assert.match(asked.text, /Напиши имейл адреса на Иван/u);

  // The agent's own step with an address the person never typed: „да“
  // prepares it and waits for „Потвърди“.
  const prepared = await request(chatApp(owner))
    .post("/chat/chat")
    .set("Cookie", `synchron_google_session=${cookie}`)
    .send({
      sessionId: "plain-mail-agent-address",
      message: "да",
      recentHistory: [
        { role: "user", content: "прати на иван че закъснявам" },
        { role: "assistant", content: "Намерих го.\n\nСледва: Изпрати имейл до ivan@example.com | Закъснявам | Ще закъснея 10 минути." },
      ],
    })
    .expect(200);
  assert.match(prepared.text, /Потвърждавам NovariumAI задача: [0-9a-f-]{36}/u);
  assert.equal(services.sends.length, 0);

  // The exact command with an address he typed himself goes at once.
  const typed = await request(chatApp(owner))
    .post("/chat/chat")
    .set("Cookie", `synchron_google_session=${cookie}`)
    .send({ sessionId: "plain-mail-typed", message: "Изпрати имейл до ivan@example.com | Закъснявам | Ще закъснея 10 минути." })
    .expect(200);
  assert.equal(services.sends.length, 1);
  assert.match(services.sentMime()[0], /^To: ivan@example\.com\r\n/u);
  assert.match(typed.text, /Имейлът е изпратен до ivan@example\.com\./u);
});

test("„каво имам в пошата днес покажи ми последните мейли“ reads the mailbox; with nothing today it shows the latest", async (t) => {
  const inbox = [{ id: "m1", subject: "Проба", from: "Ана <ana@example.com>" }];
  const services = mailServices(t, {
    intents: [plainIntent({ action: "mail.read", query: "newer_than:1d" })],
    inbox,
    search: [],
  });
  const cookie = await googleCookie(owner, GOOGLE_BASE_SCOPES, "radko@example.com");
  const response = await request(chatApp(owner))
    .post("/chat/chat")
    .set("Cookie", `synchron_google_session=${cookie}`)
    .send({ sessionId: "plain-mail-read", message: "каво имам в пошата днес покажи ми последните мейли" })
    .expect(200);
  assert.deepEqual(services.gmailReads, ["newer_than:1d", "in:anywhere"]);
  assert.match(response.text, /"capabilities":\["mail\.read"\]/u);
  // The answer is written from the letters the tool read.
  const answered = JSON.stringify(services.claude.calls.at(-1));
  assert.match(answered, /По това търсене няма писма\. Последните писма в Gmail:/u);
  assert.match(answered, /Проба — Ана <ana@example\.com>/u);
});

test("a refused mailbox read says reading is not allowed yet and sending works, never „can't send“", async (t) => {
  const services = mailServices(t, {
    intents: [plainIntent({ action: "mail.read" })],
    readStatus: 403,
  });
  const cookie = await googleCookie(owner, GOOGLE_BASE_SCOPES, "radko@example.com");
  const response = await request(chatApp(owner))
    .post("/chat/chat")
    .set("Cookie", `synchron_google_session=${cookie}`)
    .send({ sessionId: "plain-mail-refused", message: "покажи ми последните имейли в gmail" })
    .expect(200);
  assert.equal(services.gmailReads.length, 1);
  assert.match(response.text, /Четенето на пощата в Gmail още не е разрешено; изпращането на имейли работи\./u);
  assert.match(response.text, /Разреши четене на Gmail/u);
});

test("the reader is not asked for a guest; a member without their own Google sends nothing", async (t) => {
  resetGoogleSessionsForTests();
  const services = mailServices(t, { intents: [plainIntent({ recipient: "me", body: "Здраве" })] });
  const guest = { id: "guest", displayName: "Гост", role: "guest" };
  await request(chatApp(guest))
    .post("/chat/chat")
    .send({ sessionId: "plain-mail-guest", message: "ПРАТИ МЕЛ ДА МИЯ ТУК ПРИ ПОСТ ЗДРАВЕ" })
    .expect(200);
  assert.equal(services.readerCalls.length, 0);
  // A member's own branch reads their words too (their tasks, pictures); a
  // Google step without their own Google goes on as before and sends nothing.
  const response = await request(chatApp(member))
    .post("/chat/chat")
    .send({ sessionId: "plain-mail-no-google", message: "ПРАТИ МЕЛ ДА МИЯ ТУК ПРИ ПОСТ ЗДРАВЕ" })
    .expect(200);
  assert.equal(services.sends.length, 0);
  assert.doesNotMatch(response.text, /own-command-write|Имейлът е изпратен/u);
});

// Item 3 (RADKO, 28.11 04:30: „самата команда го казва“): an event in his own
// calendar and a new contact in his own Google go at once, for the owner and
// for a member with their own Google, the way his own email does.
function googleWriteServices(t, { intents = [] } = {}) {
  const readerCalls = [];
  const events = [];
  const contacts = [];
  const claude = stubClaude(t, {
    answer: (url, options) => {
      if (url === READER_URL) {
        const body = JSON.parse(options.body || "{}");
        if (body.text?.format?.name !== "novarium_plain_intent") return undefined;
        readerCalls.push(body);
        return Response.json({ output_text: JSON.stringify(intents[readerCalls.length - 1] || plainIntent({ action: "none" })) });
      }
      if (url.startsWith("https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=none") && options.method === "POST") {
        const event = JSON.parse(options.body || "{}");
        events.push(event);
        return Response.json({ id: `event-${events.length}`, status: "confirmed", htmlLink: "https://calendar.google.com/event?eid=1", ...event });
      }
      if (url.startsWith("https://www.googleapis.com/calendar/v3/calendars/primary/events?")) {
        return Response.json({ items: [] });
      }
      if (url.startsWith("https://people.googleapis.com/v1/people:createContact")) {
        const contact = JSON.parse(options.body || "{}");
        contacts.push(contact);
        return Response.json({ resourceName: `people/c${contacts.length}`, etag: "e1", ...contact });
      }
      return undefined;
    },
  });
  return { claude, readerCalls, events, contacts };
}

const inDays = (days) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

test("„запиши ми среща утре в 10 с иван“ puts the event in his own calendar at once, for the owner and a member", async (t) => {
  const date = inDays(2);
  for (const [identity, scopes] of [
    [owner, GOOGLE_BASE_SCOPES],
    [member, GOOGLE_MEMBER_SCOPES],
  ]) {
    const services = googleWriteServices(t, {
      intents: [plainIntent({ action: "calendar.write", title: "Среща с Иван", date, time: "10:00" })],
    });
    const cookie = await googleCookie(identity, scopes, `${identity.id}@example.com`);
    const response = await request(chatApp(identity))
      .post("/chat/chat")
      .set("Cookie", `synchron_google_session=${cookie}`)
      .send({ sessionId: `plain-event-${identity.role}`, message: "запиши ми среща утре в 10 с иван" })
      .expect(200);
    assert.equal(services.readerCalls.length, 1, identity.role);
    assert.equal(services.events.length, 1, `${identity.role}: ${services.claude.others.join("\n")}`);
    assert.equal(services.events[0].summary, "Среща с Иван");
    assert.match(response.text, /"mode":"own-command-write"/u, identity.role);
    assert.doesNotMatch(response.text, /Потвърждавам NovariumAI задача/u);
    const [year, month, day] = date.split("-");
    assert.match(response.text, new RegExp(`Кога: ${day}\\.${month}\\.${year} в 10:00, 60 мин\\.`, "u"), response.text);
    assert.deepEqual(services.claude.calls, []);
    t.mock.restoreAll();
  }
});

test("„добави контакт Иван Петров 0888 123 456“ saves the contact at once; without his Google nothing is written", async (t) => {
  const contact = plainIntent({ action: "contacts.create", contactName: "Иван Петров", contactPhone: "0888 123 456" });
  const services = googleWriteServices(t, { intents: [contact, contact] });
  const cookie = await googleCookie(member, GOOGLE_MEMBER_SCOPES, "ana@example.com");
  const response = await request(chatApp(member))
    .post("/chat/chat")
    .set("Cookie", `synchron_google_session=${cookie}`)
    .send({ sessionId: "plain-contact", message: "добави контакт Иван Петров 0888 123 456" })
    .expect(200);
  assert.equal(services.contacts.length, 1, services.claude.others.join("\n"));
  assert.deepEqual(services.contacts[0].phoneNumbers, [{ value: "0888 123 456" }]);
  assert.match(response.text, /"mode":"own-command-write"/u);
  assert.doesNotMatch(response.text, /Потвърждавам NovariumAI задача/u);
  // A member without their own Google: the reader is not asked for Google,
  // and nothing is written.
  resetGoogleSessionsForTests();
  const none = await request(chatApp(member))
    .post("/chat/chat")
    .send({ sessionId: "plain-contact-none", message: "добави контакт Иван Петров 0888 123 456" })
    .expect(200);
  assert.equal(services.contacts.length, 1);
  assert.doesNotMatch(none.text, /own-command-write/u);
});

test("„нарисувай ми котка“ starts the picture at once: free for the owner, priced for a member, with no model answer", async (t) => {
  for (const [identity, units, price] of [
    [owner, 0, ""],
    [member, 2, " Струва 2 единици."],
  ]) {
    const services = googleWriteServices(t, {
      intents: [plainIntent({ action: "image.make", picture: "Рижа котка на прозорец, акварел, топла светлина" })],
    });
    const response = await request(chatApp(identity))
      .post("/chat/chat")
      .send({ sessionId: `plain-picture-${identity.role}`, message: "нарисувай ми котка" })
      .expect(200);
    assert.equal(services.readerCalls.length, 1, identity.role);
    assert.match(response.text, /"mode":"plain-words-media"/u);
    assert.ok(response.text.includes(JSON.stringify(`Правя картинката. Отнема до половин минута.${price}`)), response.text);
    assert.ok(
      response.text.includes(
        `"media":{"start":true,"items":[{"kind":"image","prompt":"Рижа котка на прозорец, акварел, топла светлина","units":${units}}]}`,
      ),
      response.text,
    );
    assert.deepEqual(services.claude.calls, []);
    t.mock.restoreAll();
  }
});
