import assert from "node:assert/strict";
import test from "node:test";

import { readTodoDay, readTodoWords } from "../src/services/todoWords.js";

// Saturday 28.11.2026, 07:00 in Sofia.
const now = Date.parse("2026-11-28T05:00:00Z");
const words = (message) => readTodoWords(message, { now });

test("„Моите задачи“ in the person's own words reads the list (Team 2's probes 8 and 9)", () => {
  for (const message of [
    "моите задачи",
    "Моите задачи",
    "кви задачи имам отворени",
    "какви задачи имам",
    "покажи задачите ми",
    "кои задачи са отворени",
    "кои ми са отворените задачи",
    "имам ли отворени задачи",
    "колко задачи имам",
    "my tasks",
    "what tasks do I have",
  ]) {
    assert.deepEqual(words(message), { type: "read" }, message);
  }
});

test("„добави задача да се обадя на банката утре“ adds the task with its day (Team 2's probe 10)", () => {
  assert.deepEqual(words("добави задача да се обадя на банката утре"), {
    type: "add",
    text: "Да се обадя на банката",
    due: "2026-11-29",
  });
  assert.deepEqual(words("Запиши ми задача: да платя тока в петък"), {
    type: "add",
    text: "Да платя тока",
    due: "2026-12-04",
  });
  assert.deepEqual(words("добави задача купи мляко"), { type: "add", text: "Купи мляко", due: "" });
  assert.deepEqual(words("сложи задача да пратя офертата до 5 декември"), {
    type: "add",
    text: "Да пратя офертата",
    due: "2026-12-05",
  });
  assert.deepEqual(words("добави задача за 3.12 да се обадя на Иван"), {
    type: "add",
    text: "Да се обадя на Иван",
    due: "2026-12-03",
  });
  assert.deepEqual(words("add a task: call the bank tomorrow"), {
    type: "add",
    text: "Call the bank",
    due: "2026-11-29",
  });
  // Only the words: „добави задача“ without them adds nothing.
  assert.deepEqual(words("добави задача"), { type: "add", text: "", due: "" });
});

test("the day is counted in Sofia, and a past date without a year is next year's", () => {
  // 00:30 on Sunday 29.11 in Sofia, still the 28th in UTC.
  const late = Date.parse("2026-11-28T22:30:00Z");
  assert.equal(readTodoDay("утре", late).due, "2026-11-30");
  assert.equal(readTodoDay("днес", late).due, "2026-11-29");
  // Saturday today: „в събота“ is next Saturday, not today.
  assert.equal(readTodoDay("в събота", now).due, "2026-12-05");
  assert.equal(readTodoDay("за 1.11", now).due, "2027-11-01");
  assert.equal(readTodoDay("на 2 януари", now).due, "2027-01-02");
  assert.equal(readTodoDay("до 3.12.2026", now).due, "2026-12-03");
  // A day that does not exist is not a day.
  assert.deepEqual(readTodoDay("за 31.02", now), { due: "", rest: "за 31.02" });
});

test("work tasks keep their own words, and other things are not the list", () => {
  for (const message of [
    "какви задачи има в проекта",
    "създай работна задача за сайта",
    "покажи работните задачи",
    "добави задача в GitHub за бутона",
    "направи задача за кода",
    "какво ми е деня днес",
    "добър ден",
    "реши ми една задача по математика",
    "",
  ]) {
    assert.equal(words(message), null, message);
  }
  assert.equal(readTodoWords(undefined), null);
});
