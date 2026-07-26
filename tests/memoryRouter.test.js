import assert from "node:assert/strict";
import test from "node:test";

import {
  CLEAR_MEMORY_CONFIRMATION,
  hasClearMemoryConfirmation,
} from "../src/routes/memoryRouter.js";

function requestWithConfirmation(value) {
  return {
    get(name) {
      assert.equal(name, "x-confirm-memory-delete");
      return value;
    },
  };
}

test("bulk memory API deletion requires exact explicit confirmation", () => {
  assert.equal(hasClearMemoryConfirmation(requestWithConfirmation()), false);
  assert.equal(
    hasClearMemoryConfirmation(requestWithConfirmation("да, изтрий")),
    false,
  );
  assert.equal(
    hasClearMemoryConfirmation(
      requestWithConfirmation(CLEAR_MEMORY_CONFIRMATION),
    ),
    true,
  );
});
