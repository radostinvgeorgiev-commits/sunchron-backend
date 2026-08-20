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

  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "user");
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
  assert.match(messages[0].content, /Какво да направим днес\\?/u);
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
    ["user"],
  );
  assert.equal(
    messages.filter(({ content }) =>
      content.includes("личната AI операционна система"),
    ).length,
    1,
  );
  assert.match(messages[0].content, /Радко: Първи въпрос/u);
  assert.match(messages[0].content, /AI CORE: Първи отговор/u);
  assert.match(messages[0].content, /Следващ въпрос/u);
});

test("member context uses the member identity and safe personal tools", () => {
  const messages = buildAvatarMessages(
    [{ fact: "Любимият ми цвят е зелен", scope: "personal" }],
    [{ role: "user", content: "Здравей" }],
    "Какъв е любимият ми цвят?",
    { role: "member", displayName: "Иван" },
  );

  assert.match(messages[0].content, /личен AI асистент на Иван/u);
  assert.match(messages[0].content, /Иван: Здравей/u);
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
  assert.match(messages[0].content, /Подготви първата версия/u);
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
