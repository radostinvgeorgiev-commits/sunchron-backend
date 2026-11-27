import assert from "node:assert/strict";
import test from "node:test";
import express from "express";

import {
  createSession,
  disconnectSession,
  finishGoogleConnection,
  getLatestGoogleSessionId,
  grantedExtras,
  hasSession,
  isSaveOnlyGrant,
  linkSaveSession,
  resetGoogleSessionsForTests,
  saveSessionFor,
  setFirestoreGoogleSessionStoreForTests,
} from "../src/services/googleDriveService.js";
import googleDriveRouter from "../src/routes/googleDriveRouter.js";

const owner = { memoryOwnerId: "owner:radko", role: "owner" };
const MAIN =
  "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/contacts";
const YOUTUBE = "https://www.googleapis.com/auth/youtube.readonly";
const SAVE =
  "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/drive.file";

const idToken = (sub) =>
  ["h", Buffer.from(JSON.stringify({ sub })).toString("base64url"), "s"].join(".");
const tokens = (name, scope, sub = "google-1") => ({
  access_token: name,
  expires_in: 3600,
  scope,
  id_token: idToken(sub),
});

async function withEnvironment(values, callback) {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try {
    return await callback();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function fakeSessionStore() {
  const documents = new Map();
  return {
    documents,
    async get(id) {
      return documents.get(id) || null;
    },
    async set(id, payload) {
      documents.delete(id);
      documents.set(id, payload);
    },
    async delete(id) {
      documents.delete(id);
    },
    async listLatest(limit = 100) {
      return [...documents.entries()]
        .reverse()
        .slice(0, limit)
        .map(([id, payload]) => ({ id, payload }));
    },
  };
}

test("only a token that can do nothing but save files counts as a save token", () => {
  assert.equal(isSaveOnlyGrant(SAVE), true);
  assert.equal(isSaveOnlyGrant(`${MAIN} ${YOUTUBE}`), false);
  assert.equal(isSaveOnlyGrant(`${MAIN} https://www.googleapis.com/auth/drive.file`), false);
  assert.equal(isSaveOnlyGrant(""), false);
  assert.equal(isSaveOnlyGrant(undefined), false);
});

test("a save token never becomes the connection owner tools use", async () => {
  resetGoogleSessionsForTests();
  const main = await createSession(tokens("main", `${MAIN} ${YOUTUBE}`), owner);
  const id = await finishGoogleConnection(tokens("save", SAVE), owner, {
    previousId: main,
    saving: true,
  });
  assert.equal(id, main);
  assert.notEqual(await saveSessionFor(main), main);
  assert.equal(await getLatestGoogleSessionId(), main);

  // A save token linked before tokens were marked is skipped too.
  resetGoogleSessionsForTests();
  const older = await createSession({ access_token: "main", expires_in: 3600 }, owner);
  const unmarked = await createSession({ access_token: "save", expires_in: 3600 }, owner);
  assert.equal(await linkSaveSession(older, unmarked), true);
  assert.equal(await getLatestGoogleSessionId(), older);
});

test("after a restart the stored save token is skipped, even when it was used last", async () => {
  const store = fakeSessionStore();
  await withEnvironment(
    {
      GOOGLE_CLOUD_PROJECT: "handy-boulevard-479120-q9",
      FIRESTORE_DATABASE_ID: "(default)",
      PERSISTENCE_BACKEND: "firestore",
      GOOGLE_SESSION_ENCRYPTION_KEY: "test-google-session-key",
    },
    async () => {
      resetGoogleSessionsForTests();
      setFirestoreGoogleSessionStoreForTests(store);
      const main = await createSession({ access_token: "main", expires_in: 3600 }, owner);
      const save = await createSession({ access_token: "save", expires_in: 3600 }, owner);
      assert.equal(await linkSaveSession(main, save), true);
      // The save token was refreshed last, so it is the newest stored one.
      await store.set(save, await store.get(save));
      resetGoogleSessionsForTests();
      setFirestoreGoogleSessionStoreForTests(store);
      assert.equal(await getLatestGoogleSessionId(), main);

      // Disconnecting removes both stored tokens.
      await disconnectSession(main);
      assert.equal(store.documents.size, 0);
      assert.equal(await hasSession(save), false);
      resetGoogleSessionsForTests();
    },
  );
});

test("disconnecting also removes the linked save token", async () => {
  resetGoogleSessionsForTests();
  const main = await createSession(tokens("main", MAIN), owner);
  const save = await finishGoogleConnection(tokens("save", SAVE), owner, {
    previousId: main,
    saving: true,
  }).then(() => saveSessionFor(main));
  assert.notEqual(save, main);
  await disconnectSession(main);
  assert.equal(await hasSession(main), false);
  assert.equal(await hasSession(save), false);
});

test("a new save token replaces the old one, which is deleted", async () => {
  resetGoogleSessionsForTests();
  const main = await createSession(tokens("main", MAIN), owner);
  const first = await createSession(tokens("save-1", SAVE), owner, { saveOnly: true });
  const second = await createSession(tokens("save-2", SAVE), owner, { saveOnly: true });
  assert.equal(await linkSaveSession(main, first), true);
  assert.equal(await linkSaveSession(main, second), true);
  assert.equal(await saveSessionFor(main), second);
  assert.equal(await hasSession(first), false);
  assert.equal(await linkSaveSession(main, main), false);
});

test("in production the save link must be stored, or nothing changes", async () => {
  resetGoogleSessionsForTests();
  const main = await createSession(tokens("main", MAIN), owner);
  const save = await createSession(tokens("save", SAVE), owner, { saveOnly: true });
  await withEnvironment({ NODE_ENV: "production", PERSISTENCE_BACKEND: "local" }, async () => {
    assert.equal(await linkSaveSession(main, save), false);
  });
  assert.equal(await saveSessionFor(main), main);
});

test("a renewed connection keeps its services and the save token of the same Google account", async () => {
  resetGoogleSessionsForTests();
  const main = await createSession(
    tokens("main", `${MAIN} ${YOUTUBE} https://www.googleapis.com/auth/gmail.readonly`),
    owner,
  );
  assert.deepEqual(await grantedExtras(main), ["youtube", "gmail"]);
  const save = await createSession(tokens("save", SAVE), owner, { saveOnly: true });
  assert.equal(await linkSaveSession(main, save), true);
  assert.deepEqual(await grantedExtras(save), []);

  const renewed = await finishGoogleConnection(tokens("renewed", `${MAIN} ${YOUTUBE}`), owner, {
    previousId: main,
  });
  assert.notEqual(renewed, main);
  assert.equal(await saveSessionFor(renewed), save);

  // Another Google account does not save into the first account's Drive.
  const other = await finishGoogleConnection(tokens("other", MAIN, "google-2"), owner, {
    previousId: renewed,
  });
  assert.equal(await saveSessionFor(other), other);
});

test("a save step from before this version is still recognised by its scopes", async () => {
  resetGoogleSessionsForTests();
  const main = await createSession(tokens("main", MAIN), owner);
  const id = await finishGoogleConnection(tokens("save", SAVE), owner, { previousId: main });
  assert.equal(id, main);
  assert.notEqual(await saveSessionFor(main), main);
});

test("saving with a different Google account is refused and stores nothing", async () => {
  resetGoogleSessionsForTests();
  const main = await createSession(tokens("main", MAIN, "google-1"), owner);
  await assert.rejects(
    finishGoogleConnection(tokens("save", SAVE, "google-2"), owner, {
      previousId: main,
      saving: true,
    }),
    { code: "GOOGLE_ACCOUNT_MISMATCH" },
  );
  assert.equal(await saveSessionFor(main), main);
  assert.equal(await getLatestGoogleSessionId(), main);
});

test("connect asks for exactly what the token needs and never merges earlier grants", async () => {
  resetGoogleSessionsForTests();
  const main = await createSession(tokens("main", `${MAIN} ${YOUTUBE}`), owner);
  const app = express();
  app.use((req, _res, next) => {
    req.owner = owner;
    next();
  });
  app.use("/api/google", googleDriveRouter);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/google`;
  const open = async (path, cookie = "") => {
    const response = await fetch(`${base}${path}`, {
      redirect: "manual",
      headers: cookie ? { cookie } : {},
    });
    assert.equal(response.status, 302);
    const location = new URL(response.headers.get("location"));
    return {
      scope: location.searchParams.get("scope").split(" "),
      state: location.searchParams.get("state"),
      merge: location.searchParams.get("include_granted_scopes"),
      cookies: response.headers.get("set-cookie") || "",
    };
  };
  try {
    await withEnvironment(
      {
        GOOGLE_CLIENT_ID: "client",
        GOOGLE_CLIENT_SECRET: "secret",
        GOOGLE_REDIRECT_URI: "https://example.test/api/google/callback",
      },
      async () => {
        const cookie = `synchron_google_session=${main}`;
        const renew = await open("/connect", cookie);
        assert.equal(renew.merge, null);
        assert.ok(renew.scope.includes(YOUTUBE), "a renewal keeps YouTube");
        assert.ok(!renew.scope.includes("https://www.googleapis.com/auth/drive.file"));
        assert.ok(!renew.state.startsWith("save."));
        assert.match(renew.cookies, new RegExp(`synchron_google_state=${renew.state.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")};`, "u"));

        const gmail = await open("/connect?add=gmail", cookie);
        assert.ok(gmail.scope.includes(YOUTUBE));
        assert.ok(gmail.scope.includes("https://www.googleapis.com/auth/gmail.readonly"));
        assert.ok(gmail.scope.includes("https://www.googleapis.com/auth/calendar.events"));

        const save = await open("/connect?add=save", cookie);
        assert.deepEqual(save.scope, ["openid", "email", "https://www.googleapis.com/auth/drive.file"]);
        assert.equal(save.merge, null);
        assert.ok(save.state.startsWith("save."));

        // Without a connection, add=gmail connects Google and Gmail in one step.
        const first = await open("/connect?add=gmail");
        assert.ok(first.scope.includes("https://www.googleapis.com/auth/calendar.events"));
        assert.ok(first.scope.includes("https://www.googleapis.com/auth/gmail.readonly"));
        assert.ok(!first.scope.includes(YOUTUBE));
      },
    );
  } finally {
    server.close();
  }
});
