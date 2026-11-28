import assert from "node:assert/strict";
import test from "node:test";

import { detectCapabilityRequests } from "../src/routes/chat.js";
import { executeCapability } from "../src/tools/capabilityEngine.js";
import { createPersonalTodoService } from "../src/services/personalTodoService.js";

// Item 3, fix 4 (Team 2's probes 8, 9 and 10, 28.11): „Моите задачи“ in the
// person's own words, through the chat and the connector alike.
const sofiaDay = (offset = 0) => {
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Sofia" });
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
};
const shown = (day) => `${day.slice(8, 10)}.${day.slice(5, 7)}.${day.slice(0, 4)}`;

test("the chat reads and adds to „Моите задачи“ with the person's words", () => {
  const capabilities = (message) => detectCapabilityRequests(message).map(({ capability }) => capability);
  assert.deepEqual(capabilities("моите задачи"), ["todos.read"]);
  assert.deepEqual(capabilities("кви задачи имам отворени"), ["todos.read"]);
  assert.deepEqual(capabilities("покажи задачите ми"), ["todos.read"]);
  assert.deepEqual(detectCapabilityRequests("добави задача да се обадя на банката утре"), [
    {
      capability: "todos.add",
      action: "todos.add",
      message: "добави задача да се обадя на банката утре",
      input: { text: "Да се обадя на банката", due: sofiaDay(1) },
    },
  ]);
  // Work tasks keep their own words.
  assert.deepEqual(capabilities("покажи работните задачи"), ["tasks.read"]);
  assert.deepEqual(capabilities("създай работна задача за новия бутон"), ["tasks.draft"]);
  // Only „добави задача“, with no words of the task: nothing is added.
  assert.deepEqual(capabilities("добави задача"), []);
});

test("adding runs at once and the list shows it with its day; each person has their own list", async () => {
  const add = await executeCapability("todos.add", {
    ownerId: "todo-chat-maria",
    message: "добави задача да се обадя на банката утре",
    input: { text: "Да се обадя на банката", due: sofiaDay(1) },
  });
  assert.equal(add.requiresConfirmation, false);
  assert.equal(add.output, `Добавих в „Моите задачи“: Да се обадя на банката (утре, ${shown(sofiaDay(1))}).`);

  await executeCapability("todos.add", { ownerId: "todo-chat-maria", input: { text: "Купи мляко", due: "2026-02-31" } });
  const read = await executeCapability("todos.read", { ownerId: "todo-chat-maria", message: "моите задачи" });
  assert.equal(
    read.output,
    ["Моите задачи (2 отворени):", "• Купи мляко", `• Да се обадя на банката — утре, ${shown(sofiaDay(1))}`].join("\n"),
  );

  const english = await executeCapability("todos.read", { ownerId: "todo-chat-maria", language: "en" });
  assert.match(english.output, /^My tasks \(2 open\):\n• Купи мляко\n• Да се обадя на банката — tomorrow, /u);

  const other = await executeCapability("todos.read", { ownerId: "todo-chat-ivan" });
  assert.equal(other.output, "Нямаш отворени задачи в „Моите задачи“.");

  // The list on the page is the same list.
  const page = createPersonalTodoService();
  assert.deepEqual(
    (await page.list("todo-chat-maria")).map(({ text, due }) => [text, due || ""]),
    [["Купи мляко", ""], ["Да се обадя на банката", sofiaDay(1)]],
  );
  await assert.rejects(
    () => executeCapability("todos.read", { message: "моите задачи" }),
    { code: "CAPABILITY_AUTH_REQUIRED" },
  );
});
