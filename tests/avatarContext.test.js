import assert from "node:assert/strict";
import test from "node:test";

import { buildAvatarMessages } from "../src/routes/chat.js";

test("avatar sends identity rules and verified memory as agent-compatible context", () => {
  const messages = buildAvatarMessages(
    [
      { fact: "Живея във Варна", scope: "personal" },
      {
        fact: "Текущата цел е работещ личен AI аватар",
        scope: "project",
      },
    ],
    [],
    "Какво да направим днес?",
  );

  assert.equal(messages.length, 2);
  assert.deepEqual(
    messages.map(({ role }) => role),
    ["system", "user"],
  );
  assert.match(messages[0].content, /личната AI операционна система/u);
  assert.match(messages[0].content, /AI аватарът е интерфейсът/u);
  assert.match(messages[0].content, /избира най-подходящия AI модел/u);
  assert.match(messages[0].content, /Firestore е постоянната AI памет/u);
  assert.match(
    messages[0].content,
    /Firestore е постоянната AI памет и хранилището за потребители, настройки, разрешения, задачи и журнал/u,
  );
  assert.match(
    messages[0].content,
    /Не се изграждат токен, фондация, корпорация или масова платформа/u,
  );
  assert.match(
    messages[0].content,
    /Личните и бизнес фактите за Радко се използват само от защитената постоянна памет/u,
  );
  assert.match(messages[0].content, /Живея във Варна/u);
  assert.doesNotMatch(
    messages[0].content,
    /\[КОНТЕКСТ НА ПРОЕКТА\][\s\S]*Текущата цел е работещ личен AI аватар/u,
  );
  assert.match(messages[0].content, /без да обясняваш, че четеш памет/u);
  assert.equal(messages[1].content, "Какво да направим днес?");
});

test("avatar preserves conversation order without repeating its instructions", () => {
  const messages = buildAvatarMessages(
    [{ fact: "Предпочитам кратки отговори", scope: "personal" }],
    [
      { role: "user", content: "Първи въпрос" },
      { role: "assistant", content: "Първи отговор" },
    ],
    "Следващ въпрос",
  );

  assert.deepEqual(
    messages.map(({ role }) => role),
    ["system", "user", "assistant", "user"],
  );
  assert.equal(
    messages.filter(({ content }) =>
      content.includes("личната AI операционна система"),
    ).length,
    1,
  );
  assert.equal(messages[1].content, "Първи въпрос");
  assert.equal(messages[2].content, "Първи отговор");
  assert.equal(messages[3].content, "Следващ въпрос");
});

test("an English page asks for an English Next line, a Bulgarian page keeps Следва", () => {
  const english = buildAvatarMessages([], [], "Show my YouTube channel", undefined, {
    mode: "chat",
    language: "en",
  })[0].content;
  assert.match(english, /`Next: one specific step`/u);
  assert.doesNotMatch(english, /`Следва: конкретна стъпка`/u);
  const member = buildAvatarMessages(
    [],
    [],
    "Find contact Reviewer Demo",
    { role: "member", displayName: "Ana" },
    { mode: "chat", language: "en" },
  )[0].content;
  assert.match(member, /`Next: one specific step`/u);
  const bulgarian = buildAvatarMessages([], [], "Покажи канала ми", undefined, {
    mode: "chat",
    language: "bg",
  })[0].content;
  assert.match(bulgarian, /`Следва: конкретна стъпка`/u);
  assert.doesNotMatch(bulgarian, /`Next: one specific step`/u);
});

test("member context uses the member identity and safe personal tools", () => {
  const messages = buildAvatarMessages(
    [{ fact: "Любимият ми цвят е зелен", scope: "personal" }],
    [{ role: "user", content: "Здравей" }],
    "Какъв е любимият ми цвят?",
    { role: "member", displayName: "Иван" },
  );

  assert.match(messages[0].content, /личен AI асистент на Иван/u);
  assert.equal(messages[1].content, "Здравей");
  assert.match(messages[0].content, /Любимият ми цвят е зелен/u);
  assert.doesNotMatch(messages[0].content, /Радко/u);
  assert.doesNotMatch(
    messages[0].content,
    /radostinvgeorgiev-commits|Google Cloud project/u,
  );
  assert.match(messages[0].content, /интернет търсене/u);
  assert.match(messages[0].content, /памет само на този профил/u);
  assert.match(
    messages[0].content,
    /GitHub, Google и инфраструктурните инструменти не са достъпни/u,
  );
});

test("work mode adds bounded project and personal-agent context", () => {
  const messages = buildAvatarMessages(
    [],
    [],
    "Подготви първата версия",
    { role: "member", displayName: "Иван" },
    {
      mode: "work",
      workContext: {
        project: {
          name: "Моят сайт",
          objective: "Работеща начална страница за преглед",
        },
        agent: {
          name: "Майстор",
          role: "builder",
          purpose: "Показвай проверките",
        },
      },
    },
  );

  assert.match(messages[0].content, /Активен проект: Моят сайт/u);
  assert.match(messages[0].content, /Избран личен агент: Майстор/u);
  assert.match(messages[0].content, /Роля: Създател на проекти/u);
  assert.match(messages[0].content, /не отменя разрешенията/u);
  assert.equal(messages.at(-1).content, "Подготви първата версия");
});

test("chat mode does not add work-project context", () => {
  const messages = buildAvatarMessages(
    [],
    [],
    "Здравей",
    { role: "member", displayName: "Иван" },
    { mode: "chat", workContext: null },
  );

  assert.doesNotMatch(messages[0].content, /РАБОТЕН РЕЖИМ/u);
});

test("avatar receives approved archive knowledge separately from verified memory", () => {
  const messages = buildAvatarMessages(
    [],
    [],
    "Каква е посоката?",
    { role: "owner", displayName: "Радко" },
    { mode: "chat", workContext: null },
    [
      {
        text: "Първият демонстрационен контур е здраве, задачи и памет.",
        category: "decision",
        scope: "project",
        sourceTitle: "Основата",
        status: "approved",
      },
    ],
  );

  assert.match(messages[0].content, /РАЗРЕШЕНО ЗНАНИЕ ОТ АРХИВА/u);
  assert.match(messages[0].content, /Първият демонстрационен контур/u);
  assert.match(messages[0].content, /източник: Основата/u);
});

test("the reply language rule closes the system context, after the Bulgarian rules and notes", () => {
  const english = buildAvatarMessages(
    [{ fact: "Живея във Варна", scope: "personal" }],
    [{ role: "user", content: "Add a contact: Ana Lee | ana@example.com" }],
    "Find contact Ana Lee",
    undefined,
    {
      mode: "chat",
      workContext: null,
      language: "en",
      avatarProfile: "Кой съм: програмист",
    },
  );
  const system = english[0].content;
  assert.match(
    system,
    /\[REPLY LANGUAGE\] Reply in the language explicitly requested in the latest user message\. Otherwise reply in the language of that message\. If its language is unclear, use English\. The Bulgarian rules, notes and memory above do not by themselves set the reply language\.$/u,
  );
  assert.ok(system.indexOf("[REPLY LANGUAGE]") > system.indexOf("Кой съм: програмист"));
  assert.ok(system.indexOf("[REPLY LANGUAGE]") > system.indexOf("Живея във Варна"));
  assert.equal(system.match(/Reply in the language explicitly requested/gu).length, 1);
  assert.equal(english.at(-1).content, "Find contact Ana Lee");

  const bulgarian = buildAvatarMessages([], [], "Намери контакт Ана");
  assert.match(bulgarian[0].content, /If its language is unclear, use Bulgarian\.[^\n]*$/u);
});

test("the model knows today's date in Sofia, so „какво ми е деня днес“ gets today", () => {
  // 04:45 UTC on 28.11.2026 is 06:45 on Saturday in Sofia.
  const now = new Date("2026-11-28T04:45:00Z");
  const [bulgarian] = buildAvatarMessages([], [], "какво ми е деня днес", undefined, {
    mode: "chat",
    workContext: null,
    now,
  });
  assert.match(bulgarian.content, /\[ДНЕС\] Днес е събота, 28 ноември 2026 г\., 06:45 ч\. \(София\)\./u);
  assert.ok(bulgarian.content.indexOf("[ДНЕС]") < bulgarian.content.indexOf("[REPLY LANGUAGE]"));
  assert.match(bulgarian.content, /\[REPLY LANGUAGE\][^\n]*$/u);

  const [english] = buildAvatarMessages([], [], "what's my day", undefined, {
    mode: "chat",
    workContext: null,
    language: "en",
    now,
  });
  assert.match(english.content, /\[TODAY\] Today is Saturday, 28 November 2026, 06:45 in Sofia\./u);

  // Late in the evening UTC it is already the next day in Sofia.
  const [late] = buildAvatarMessages([], [], "какво имам утре", undefined, {
    mode: "chat",
    workContext: null,
    now: new Date("2026-11-28T22:30:00Z"),
  });
  assert.match(late.content, /Днес е неделя, 29 ноември 2026 г\., 00:30 ч\./u);

  // Without a given time the real clock is used: the year is never a guess.
  const [current] = buildAvatarMessages([], [], "коя дата сме", undefined, { mode: "chat", workContext: null });
  const year = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Sofia" }).slice(0, 4);
  assert.match(current.content, new RegExp(`\\[ДНЕС\\] Днес е [^\\n]* ${year} г\\.`, "u"));
});
