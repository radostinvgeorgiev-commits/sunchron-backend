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
  assert.equal(messages[0].role, "user");
  assert.match(messages[0].content, /личният AI асистент и AI аватар/u);
  assert.match(messages[0].content, /Живея във Варна/u);
  assert.match(messages[0].content, /работещ личен AI аватар/u);
  assert.match(messages[0].content, /без да обясняваш, че четеш памет/u);
  assert.deepEqual(messages[1], {
    role: "user",
    content: "Какво да направим днес?",
  });
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
    ["user", "user", "assistant", "user"],
  );
  assert.equal(
    messages.filter(({ content }) =>
      content.includes("личният AI асистент и AI аватар"),
    ).length,
    1,
  );
  assert.equal(messages.at(-1).content, "Следващ въпрос");
});
