import assert from "node:assert/strict";
import test from "node:test";

import { isCalendarReadRequest } from "../src/services/calendarService.js";

test("recognizes calendar questions without owning a second OAuth flow", () => {
  assert.equal(isCalendarReadRequest("Какво имам в календара?"), true);
  assert.equal(isCalendarReadRequest("Покажи срещите ми."), true);
  assert.equal(isCalendarReadRequest("Как работи GitHub?"), false);
});
