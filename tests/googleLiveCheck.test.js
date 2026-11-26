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

test("an expired Google sign-in asks to connect again instead of showing broken tools", async () => {
  const results = await checkGoogleServices("session", {
    drive: async () => {
      throw new GoogleDriveError("Google връзката е изтекла.", 401, "REFRESH_FAILED");
    },
  });
  assert.deepEqual(results.drive, {
    ok: false,
    connect: "/api/google/connect",
    reconnect: true,
    reason: "Връзката с Google изтече.",
  });
});

test("checks that start together share one token refresh", async () => {
  const { createSession, listDriveFiles } = await import("../src/services/googleDriveService.js");
  const saved = { ...process.env };
  Object.assign(process.env, {
    GOOGLE_CLIENT_ID: "client",
    GOOGLE_CLIENT_SECRET: "secret",
    GOOGLE_REDIRECT_URI: "https://example.test/callback",
  });
  try {
    const id = await createSession({ access_token: "old", refresh_token: "refresh", expires_in: 1 });
    let refreshes = 0;
    const fetchImpl = async (url) => {
      if (String(url).includes("oauth2.googleapis.com/token")) {
        refreshes += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return new Response(JSON.stringify({ access_token: "new", expires_in: 3600 }), { status: 200 });
      }
      return new Response(JSON.stringify({ files: [] }), { status: 200 });
    };
    await Promise.all([listDriveFiles(id, fetchImpl), listDriveFiles(id, fetchImpl), listDriveFiles(id, fetchImpl)]);
    assert.equal(refreshes, 1);
  } finally {
    for (const key of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});
