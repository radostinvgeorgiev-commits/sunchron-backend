import test from "node:test";
import assert from "node:assert/strict";

import { checkGoogleServices } from "../src/routes/googleDriveRouter.js";
import { GoogleDriveError } from "../src/services/googleDriveService.js";

test("the tools list says a Google service works only when a real call answered", async () => {
  const results = await checkGoogleServices("session", {
    drive: async () => [],
    contacts: async () => {
      throw new GoogleDriveError("Google отказа достъп до контактите.", 403, "FORBIDDEN");
    },
    gmail: async () => {
      throw new Error("token=secret-value leaked");
    },
  });
  assert.deepEqual(results.drive, { ok: true });
  assert.equal(results.contacts.ok, false);
  assert.match(results.contacts.reason, /контактите/u);
  assert.equal(results.gmail.ok, false);
  // Unknown errors never pass their text (which could hold a token) through.
  assert.equal(results.gmail.reason, "Не отговори.");
});

test("the tools list no longer prints a plain green „Работи“ without a check", async () => {
  const { readFileSync } = await import("node:fs");
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(app, /return \{ label: "Работи", className: "allow" \}/u);
  assert.match(app, /fetch\("\/api\/google\/check"/u);
});
