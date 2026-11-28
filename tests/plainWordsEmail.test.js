import assert from "node:assert/strict";
import test from "node:test";

import {
  formatSentEmailReply,
  isOwnCommandEmail,
  readPlainWordsPlan,
  sentEmailFailureReply,
  withPlainWordsRequests,
} from "../src/routes/chat.js";
import { sendMcpAgentMessage } from "../src/services/mcpAgentConversationService.js";
import { hasMailWords } from "../src/services/plainIntentService.js";

// Item 3, fix 1 (RADKO 28.11 05:26–05:41): an email and the mailbox in the
// person's own words. These are his messages from the live site.
const mailIntent = (fields = {}) => ({
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

function reader(answer) {
  const calls = [];
  const read = async (options) => {
    calls.push(options);
    return typeof answer === "function" ? answer(options) : answer;
  };
  return { calls, read };
}

test("his words for mail are mail words; other words are not", () => {
  for (const words of [
    "ISKAM DA PATI MEIL DO MEN",
    "ПРАТИ МЕЛ ДА МИЯ",
    "каво имам в пошата днес покажи ми последните мейли",
    "покажи ми последните имейли в gmail",
    "прати емайл на иван",
    "iskam da prata mail do men",
  ]) {
    assert.equal(hasMailWords(words), true, words);
  }
  for (const words of [
    "какво ми е деня днес",
    "кажи дали видеото да е вертикално за телефон.",
    "мелница",
    "нарисувай ми картинка звезда над морето през ноща",
  ]) {
    assert.equal(hasMailWords(words), false, words);
  }
});

test("the reader is asked for mail words, for an answer to its own question, and for a yes to a mail step only", async () => {
  const { calls, read } = reader(mailIntent({ recipient: "me", body: "Здраве" }));
  const apiKey = "stand-in";

  // Mail words: asked.
  const plan = await readPlainWordsPlan({ message: "ПРАТИ МЕЛ ДА МИЯ здраве", apiKey, read });
  assert.equal(plan.type, "requests");
  assert.equal(calls.length, 1);

  // The answer to its own question („Какво да пише в имейла?“): asked, with
  // the turns before it.
  const turns = [
    { role: "user", content: "ISKAM DA PATI MEIL DO MEN" },
    { role: "assistant", content: "Какво да пише в имейла? Напиши текста (и темата, ако искаш) и го пращам веднага." },
  ];
  await readPlainWordsPlan({ message: "ТУК ПРИ ПОСТ ЗДРАВЕ", turns, apiKey, read });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].turns, turns);

  // A yes to a step about mail: asked. A yes to any other step, or with no
  // step: not asked.
  await readPlainWordsPlan({ message: "да", step: "кажи „да“ и пращам имейла до теб.", apiKey, read });
  assert.equal(calls.length, 3);
  for (const step of ["", "кажи дали видеото да е вертикално за телефон."]) {
    assert.deepEqual(await readPlainWordsPlan({ message: "да", step, apiKey, read }), { type: "none" });
  }
  assert.equal(calls.length, 3);

  // No mail words: not asked.
  for (const message of ["какво ми е деня днес", "здравей", "нарисувай ми звезда"]) {
    assert.deepEqual(await readPlainWordsPlan({ message, apiKey, read }), { type: "none" });
  }
  assert.equal(calls.length, 3);

  // The exact command keeps its own path; no key, no reader.
  assert.deepEqual(
    await readPlainWordsPlan({ message: "Изпрати имейл до мен | Проба | Здравей", apiKey, read }),
    { type: "none" },
  );
  assert.deepEqual(await readPlainWordsPlan({ message: "прати мейл до мен", read }), { type: "none" });
  assert.equal(calls.length, 3);
});

test("the reader's email to the person runs; a missing detail asks one question; an untyped address never runs", async () => {
  const apiKey = "stand-in";
  const plan = (intent, message, turns = []) =>
    readPlainWordsPlan({ message, turns, apiKey, read: reader(intent).read });

  // „до мен“ with a text: one mail.send to the person's own address.
  assert.deepEqual(await plan(mailIntent({ recipient: "me", subject: "Здраве", body: "Тук при пост, здраве." }), "ПРАТИ МЕЛ ДА МИЯ ТУК ПРИ ПОСТ ЗДРАВЕ"), {
    type: "requests",
    requests: [
      {
        capability: "mail.send",
        action: "mail.send",
        message: "ПРАТИ МЕЛ ДА МИЯ ТУК ПРИ ПОСТ ЗДРАВЕ",
        input: { to: "", toSelf: true, subject: "Здраве", body: "Тук при пост, здраве." },
      },
    ],
  });

  // No text yet: the text is asked for; nothing runs.
  const noText = await plan(mailIntent({ recipient: "me" }), "ISKAM DA PATI MEIL DO MEN");
  assert.equal(noText.type, "ask");
  assert.match(noText.text, /^Какво да пише в имейла\?/u);

  // An address the person did not type (the reader took it from somewhere
  // else): asked, never sent.
  const untyped = await plan(mailIntent({ recipient: "ivan@example.com", recipientName: "Иван", body: "Здравей" }), "прати мейл на иван здравей");
  assert.equal(untyped.type, "ask");
  assert.match(untyped.text, /Иван/u);

  // An address the person typed in an earlier message counts.
  const typed = await plan(
    mailIntent({ recipient: "ivan@example.com", body: "Здравей" }),
    "прати му мейл здравей",
    [{ role: "user", content: "адресът на иван е ivan@example.com" }],
  );
  assert.equal(typed.type, "requests");
  assert.equal(typed.requests[0].input.to, "ivan@example.com");

  // Reading the mailbox: the reader's search words go with the request.
  assert.deepEqual(
    await plan(mailIntent({ action: "mail.read", query: "newer_than:1d" }), "каво имам в пошата днес покажи ми последните мейли"),
    {
      type: "requests",
      requests: [
        {
          capability: "mail.read",
          action: "mail.read",
          message: "каво имам в пошата днес покажи ми последните мейли",
          input: { query: "newer_than:1d" },
        },
      ],
    },
  );

  // Any other action is not this fix: nothing changes.
  for (const action of ["none", "calendar.read", "contacts.read", "image.make"]) {
    assert.deepEqual(await plan(mailIntent({ action, query: "Иван" }), "покажи ми пощата"), { type: "none" }, action);
  }
  // The reader failed: nothing changes.
  assert.deepEqual(await plan(null, "покажи ми пощата"), { type: "none" });
});

test("the reader's mail requests replace the detector's mail ones and keep the rest", () => {
  const send = { capability: "mail.send", action: "mail.send", message: "m", input: { to: "", toSelf: true, subject: "S", body: "B" } };
  const detected = [
    { capability: "mail.read", action: "mail.read", message: "m" },
    { capability: "calendar.read", action: "calendar.read", message: "m" },
  ];
  assert.deepEqual(withPlainWordsRequests({ type: "requests", requests: [send] }, detected), [send, detected[1]]);
  assert.deepEqual(withPlainWordsRequests({ type: "none" }, detected), detected);
  assert.deepEqual(withPlainWordsRequests({ type: "ask", text: "?" }, detected), detected);
  assert.deepEqual(withPlainWordsRequests(undefined, undefined), []);
});

test("an email is the person's own command only to themselves or to an address they typed", () => {
  const mail = (input) => ({ capability: "mail.send", input });
  assert.equal(isOwnCommandEmail(mail({ to: "", toSelf: true, subject: "S", body: "B" })), true);
  assert.equal(isOwnCommandEmail(mail({ to: "ivan@example.com", subject: "S", body: "B" }), ["прати на IVAN@example.com"]), true);
  // The address came from the assistant or a tool: it keeps „Потвърди“.
  assert.equal(isOwnCommandEmail(mail({ to: "ivan@example.com", subject: "S", body: "B" }), ["прати на иван"]), false);
  assert.equal(isOwnCommandEmail(mail({ to: "ivan@example.com", toSelf: true }), []), false);
  assert.equal(isOwnCommandEmail(mail({ to: "not an address" }), ["not an address"]), false);
  // Not an email.
  assert.equal(isOwnCommandEmail({ capability: "calendar.write", input: { toSelf: true } }), false);
  assert.equal(isOwnCommandEmail(null), false);
});

test("the answer after the email says what went, and a failure says why in Google's words", () => {
  assert.equal(
    formatSentEmailReply("Имейлът е изпратен до ana@example.com.", { subject: "Здраве", body: "Тук при пост, здраве." }),
    "Имейлът е изпратен до ana@example.com.\nТема: Здраве\nТекст: Тук при пост, здраве.",
  );
  assert.equal(formatSentEmailReply("", {}, true), "The email was sent.");
  assert.equal(formatSentEmailReply("", { body: "x".repeat(700) }).split("\n")[1], `Текст: ${"x".repeat(599)}…`);

  const refused = Object.assign(new Error("task"), {
    results: [{ error: { code: "GOOGLE_SCOPE_REQUIRED", message: "Gmail няма дадено разрешение." } }],
  });
  assert.equal(sentEmailFailureReply(refused), "Имейлът не тръгна: Gmail няма дадено разрешение.");
  // Any other failure: no made-up reason.
  assert.equal(
    sentEmailFailureReply(Object.assign(new Error("secret detail"), { code: "TASK_WRITE_FAILED" })),
    "Имейлът не тръгна. Нищо не е изпратено; опитай пак след минута.",
  );
  assert.equal(sentEmailFailureReply(null, true), "The email was not sent. Nothing went out; try again in a minute.");
});

// The connector reads the same words; there an email is still only prepared
// for the owner's exact confirmation.
function connectorWorkspace() {
  return {
    state: {
      activeProjectId: "project-1",
      activeAgentId: "agent-1",
      projects: [{ id: "project-1", name: "Проба", objective: "", run: null }],
      agents: [{ id: "agent-1", name: "NovariumAI", role: "builder", model: "auto", purpose: "", engine: "novarium" }],
    },
  };
}

function connectorDependencies({ readWords, runTask, askAi }) {
  return {
    loadWorkspace: async () => connectorWorkspace(),
    listMemories: async () => [],
    listMessages: async () => [],
    askAi: askAi || (async () => "Отговор на модела."),
    saveTurn: async () => {},
    createSessionId: () => "mcp-plain-words",
    runTask: runTask || (async () => ({ results: [], requests: [] })),
    getGoogleSession: async () => "google-session",
    getGitHubSession: async () => null,
    auditTask: async () => {},
    readWords,
  };
}

test("the connector reads his mail words: the mailbox runs with Google, and a missing detail asks", async () => {
  const owner = { role: "owner", displayName: "Радко" };
  let taskOptions;
  const read = { capability: "mail.read", action: "mail.read", message: "каво имам в пошата", input: { query: "newer_than:1d" } };
  const result = await sendMcpAgentMessage(
    { ownerId: "primary-user", message: "каво имам в пошата днес покажи ми последните мейли", identity: owner },
    connectorDependencies({
      readWords: async ({ message, turns }) => {
        assert.equal(message, "каво имам в пошата днес покажи ми последните мейли");
        assert.deepEqual(turns, []);
        return { type: "requests", requests: [read] };
      },
      runTask: async (options) => {
        taskOptions = options;
        return {
          requests: [read],
          results: [
            {
              status: "fulfilled",
              request: read,
              result: { output: "Последни съобщения в Gmail:\n• Проба — ana@example.com", requiresConfirmation: false },
            },
          ],
          task: { id: "task-1", status: "completed", verified: true },
          plannerUsed: false,
        };
      },
    }),
  );
  assert.deepEqual(taskOptions.fallbackRequests, [read]);
  assert.equal(taskOptions.planningAllowed, false);
  assert.equal(taskOptions.executionContext.googleSessionId, "google-session");
  // A write is still only prepared on the connector.
  assert.equal(taskOptions.executionContext.prepareConfirmation, true);
  assert.match(result.response, /Последни съобщения в Gmail/u);

  const asked = await sendMcpAgentMessage(
    { ownerId: "primary-user", message: "ISKAM DA PATI MEIL DO MEN", identity: owner },
    connectorDependencies({
      readWords: async () => ({ type: "ask", text: "Какво да пише в имейла? Напиши текста и го пращам веднага." }),
      runTask: async () => assert.fail("nothing runs before the text is there"),
      askAi: async () => assert.fail("the question is the answer"),
    }),
  );
  assert.equal(asked.response, "Какво да пише в имейла? Напиши текста и го пращам веднага.");
  assert.deepEqual(asked.capabilities, []);

  // „Don't use tools“ is kept: the reader is not asked.
  await sendMcpAgentMessage(
    { ownerId: "primary-user", message: "Разкажи ми за пощата, без да използваш инструменти", identity: owner },
    connectorDependencies({ readWords: async () => assert.fail("no tools were asked for") }),
  );
});
