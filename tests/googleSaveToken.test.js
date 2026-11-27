import assert from "node:assert/strict";
import test from "node:test";
import express from "express";

import {
  createSession,
  disconnectGoogleAccount,
  disconnectSession,
  finishGoogleConnection,
  getLatestGoogleSessionId,
  grantedExtras,
  hasSession,
  isSaveOnlyGrant,
  latestMainSessionFor,
  linkSaveSession,
  linkedGrantKind,
  publishSessionFor,
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
const GMAIL = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.modify",
].join(" ");
const FIRESTORE_ENV = {
  GOOGLE_CLOUD_PROJECT: "handy-boulevard-479120-q9",
  FIRESTORE_DATABASE_ID: "(default)",
  PERSISTENCE_BACKEND: "firestore",
  GOOGLE_SESSION_ENCRYPTION_KEY: "test-google-session-key",
};

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
  const { id } = await finishGoogleConnection(tokens("save", SAVE), owner, {
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

  // A save step from a browser with no main connection links nothing, and is
  // still never the connection owner tools use.
  resetGoogleSessionsForTests();
  const alone = await createSession(tokens("main", MAIN), owner);
  const { id: unlinked } = await finishGoogleConnection(tokens("save", SAVE), owner, {
    previousId: null,
    saving: true,
  });
  assert.notEqual(unlinked, alone);
  assert.equal(await getLatestGoogleSessionId(), alone);
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

  // Gmail was left unticked: the old connection stays and the page asks again.
  const narrower = await finishGoogleConnection(tokens("narrower", `${MAIN} ${YOUTUBE}`), owner, {
    previousId: main,
  });
  assert.deepEqual(narrower, { id: main, partial: true });

  const { id: renewed } = await finishGoogleConnection(
    tokens("renewed", `${MAIN} ${YOUTUBE} https://www.googleapis.com/auth/gmail.readonly`),
    owner,
    { previousId: main },
  );
  assert.notEqual(renewed, main);
  assert.equal(await saveSessionFor(renewed), save);

  // Another Google account does not save into the first account's Drive.
  // Another Google account is a new connection, not a narrower one.
  const { id: other } = await finishGoogleConnection(tokens("other", MAIN, "google-2"), owner, {
    previousId: renewed,
  });
  assert.equal(await saveSessionFor(other), other);
});

test("a save step from before this version is still recognised by its scopes", async () => {
  resetGoogleSessionsForTests();
  const main = await createSession(tokens("main", MAIN), owner);
  const { id } = await finishGoogleConnection(tokens("save", SAVE), owner, { previousId: main });
  assert.equal(id, main);
  assert.notEqual(await saveSessionFor(main), main);
});

test("saving with a different Google account is refused and stores nothing", async () => {
  const store = fakeSessionStore();
  await withEnvironment(FIRESTORE_ENV, async () => {
    resetGoogleSessionsForTests();
    setFirestoreGoogleSessionStoreForTests(store);
    const main = await createSession(tokens("main", MAIN, "google-1"), owner);
    await assert.rejects(
      finishGoogleConnection(tokens("save", SAVE, "google-2"), owner, {
        previousId: main,
        saving: true,
      }),
      { code: "GOOGLE_ACCOUNT_MISMATCH" },
    );
    assert.deepEqual([...store.documents.keys()], [main]);
    assert.equal(await saveSessionFor(main), main);
    assert.equal(await getLatestGoogleSessionId(), main);
    resetGoogleSessionsForTests();
  });
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

        // A main token from before saving had its own token holds drive.file:
        // adding YouTube to it never turns into the save step.
        const old = await createSession(
          tokens("old", `${MAIN} https://www.googleapis.com/auth/drive.file`),
          owner,
        );
        const addYoutube = await open("/connect?add=youtube", `synchron_google_session=${old}`);
        assert.ok(addYoutube.scope.includes(YOUTUBE));
        assert.ok(!addYoutube.scope.includes("https://www.googleapis.com/auth/drive.file"));
        assert.ok(!addYoutube.state.startsWith("save."));

        // Without any connection, add=gmail connects Google and Gmail in one step.
        resetGoogleSessionsForTests();
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

test("an older main token that itself holds drive.file keeps saving after a renewal", async () => {
  resetGoogleSessionsForTests();
  const older = await createSession(
    tokens("older", `${MAIN} https://www.googleapis.com/auth/drive.file`),
    owner,
  );
  const { id } = await finishGoogleConnection(tokens("renewed", MAIN), owner, { previousId: older });
  assert.notEqual(id, older);
  assert.equal(await saveSessionFor(id), older);
  assert.equal(await getLatestGoogleSessionId(), id);
});

test("a save link made on another server instance is not lost", async () => {
  const store = fakeSessionStore();
  await withEnvironment(
    {
      GOOGLE_CLOUD_PROJECT: "handy-boulevard-479120-q9",
      FIRESTORE_DATABASE_ID: "(default)",
      PERSISTENCE_BACKEND: "firestore",
      GOOGLE_SESSION_ENCRYPTION_KEY: "test-google-session-key",
      GOOGLE_CLIENT_ID: "client",
      GOOGLE_CLIENT_SECRET: "secret",
      GOOGLE_REDIRECT_URI: "https://example.test/api/google/callback",
    },
    async () => {
      resetGoogleSessionsForTests();
      setFirestoreGoogleSessionStoreForTests(store);
      // This instance cached the main connection before the link existed,
      // and its token is about to expire.
      const main = await createSession(
        { ...tokens("main", MAIN), expires_in: 1, refresh_token: "refresh" },
        owner,
      );
      const save = await createSession(tokens("save", SAVE), owner, { saveOnly: true });
      const cached = await import("../src/services/googleDriveService.js");
      // Another instance links the save token: only the stored copy changes.
      const stored = cached.decryptGoogleSession(await store.get(main));
      await store.set(main, cached.encryptGoogleSession({ ...stored, saveSessionId: save }));

      // A token refresh here, with the old cached copy, keeps the stored link.
      await cached.listGoogleCalendarEvents(main, 1, 1, async (url) =>
        String(url).includes("oauth2.googleapis.com/token")
          ? new Response(JSON.stringify({ access_token: "fresh", expires_in: 3600 }), { status: 200 })
          : new Response(JSON.stringify({ items: [] }), { status: 200 }),
      );
      const afterRefresh = cached.decryptGoogleSession(await store.get(main));
      assert.equal(afterRefresh.saveSessionId, save);
      assert.equal(afterRefresh.access_token, "fresh");
      assert.equal(await saveSessionFor(main), save);

      // Disconnecting from here deletes the save token linked elsewhere.
      await disconnectSession(main);
      assert.equal(store.documents.size, 0);
      resetGoogleSessionsForTests();
    },
  );
});

test("a connect from a new browser keeps the account's services and Google account", async () => {
  resetGoogleSessionsForTests();
  const main = await createSession(tokens("main", `${MAIN} ${YOUTUBE}`, "google-7"), owner);
  const app = express();
  app.use((req, _res, next) => {
    req.owner = owner;
    next();
  });
  app.use("/api/google", googleDriveRouter);
  const server = app.listen(0);
  try {
    await withEnvironment(
      {
        GOOGLE_CLIENT_ID: "client",
        GOOGLE_CLIENT_SECRET: "secret",
        GOOGLE_REDIRECT_URI: "https://example.test/api/google/callback",
      },
      async () => {
        const response = await fetch(
          `http://127.0.0.1:${server.address().port}/api/google/connect`,
          { redirect: "manual" },
        );
        const location = new URL(response.headers.get("location"));
        assert.ok(location.searchParams.get("scope").split(" ").includes(YOUTUBE));
        assert.equal(location.searchParams.get("login_hint"), "google-7");
        const save = new URL(
          (
            await fetch(`http://127.0.0.1:${server.address().port}/api/google/connect?add=save`, {
              redirect: "manual",
            })
          ).headers.get("location"),
        );
        assert.equal(save.searchParams.get("login_hint"), "google-7");
        // The page language (set by locale.js) opens Google's screens in it.
        const english = new URL(
          (
            await fetch(`http://127.0.0.1:${server.address().port}/api/google/connect`, {
              redirect: "manual",
              headers: { cookie: "ai_core_language=en" },
            })
          ).headers.get("location"),
        );
        assert.equal(english.searchParams.get("hl"), "en");
        assert.equal(location.searchParams.get("hl"), null);
      },
    );
  } finally {
    server.close();
  }
  assert.ok(main);
});

test("the Drive drawer offers a reconnect for an expired Google sign-in", async () => {
  const { readFileSync } = await import("node:fs");
  const drawer = readFileSync(new URL("../public/google-drive.js", import.meta.url), "utf8");
  assert.match(drawer, /RECONNECT_CODES\.has\(error\.code\)/u);
  assert.match(drawer, /href="\/api\/google\/connect"/u);
  assert.match(drawer, /google=partial|outcome === "partial"/u);

  // Gmail opened before any connection: the main connect, never the
  // restricted mail scopes in a person's first consent.
  const apps = readFileSync(new URL("../public/google-apps.js", import.meta.url), "utf8");
  assert.match(apps, /add && status\.connected\s*\?/u);
});

test("a save token two connections share is kept until the last one disconnects", async () => {
  resetGoogleSessionsForTests();
  const phone = await createSession(tokens("phone", MAIN), owner);
  const desktop = await createSession(tokens("desktop", MAIN), owner);
  const save = await createSession(tokens("save", SAVE), owner, { saveOnly: true });
  assert.equal(await linkSaveSession(phone, save), true);
  assert.equal(await linkSaveSession(desktop, save), true);
  await disconnectSession(phone);
  assert.equal(await hasSession(save), true);
  assert.equal(await saveSessionFor(desktop), save);
  await disconnectSession(desktop);
  assert.equal(await hasSession(save), false);
});

test("a save token that stopped working is forgotten and saving asks again", async () => {
  resetGoogleSessionsForTests();
  const main = await createSession(tokens("main", MAIN), owner);
  // Its access expired and Google gave no refresh token: it cannot work again.
  const dead = await createSession({ ...tokens("dead", SAVE), expires_in: 1 }, owner, {
    saveOnly: true,
  });
  assert.equal(await linkSaveSession(main, dead), true);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.owner = owner;
    next();
  });
  app.use("/api/google", googleDriveRouter);
  const server = app.listen(0);
  try {
    await withEnvironment(
      {
        GOOGLE_CLIENT_ID: "client",
        GOOGLE_CLIENT_SECRET: "secret",
        GOOGLE_REDIRECT_URI: "https://example.test/api/google/callback",
      },
      async () => {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/google/save`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie: `synchron_google_session=${main}` },
          body: JSON.stringify({ kind: "doc", title: "План", text: "Текст" }),
        });
        assert.equal(response.status, 403);
        const data = await response.json();
        assert.equal(data.code, "GOOGLE_SCOPE_REQUIRED");
        assert.equal(data.connect, "/api/google/connect?add=save");
      },
    );
  } finally {
    server.close();
  }
  assert.equal(await saveSessionFor(main), main);
  assert.equal(await hasSession(dead), false);
});


test("a grant with only part of the mail permissions does not replace the connection", async () => {
  resetGoogleSessionsForTests();
  const main = await createSession(tokens("main", `${MAIN} ${GMAIL}`), owner);
  const readOnly = await finishGoogleConnection(
    tokens("read-only", `${MAIN} https://www.googleapis.com/auth/gmail.readonly`),
    owner,
    { previousId: main },
  );
  assert.deepEqual(readOnly, { id: main, partial: true });

  // Scopes a connect no longer asks for (the first owner set) never block a renewal.
  const legacy = await createSession(
    tokens(
      "legacy",
      [
        "openid email https://www.googleapis.com/auth/drive.readonly",
        GMAIL,
        "https://www.googleapis.com/auth/calendar.events",
        "https://www.googleapis.com/auth/contacts.readonly",
        "https://www.googleapis.com/auth/contacts",
        "https://www.googleapis.com/auth/drive.file",
      ].join(" "),
    ),
    owner,
  );
  const renewed = await finishGoogleConnection(
    tokens("renewed", `${MAIN} ${GMAIL} https://www.googleapis.com/auth/drive.readonly`),
    owner,
    { previousId: legacy },
  );
  assert.equal(renewed.partial, undefined);
  assert.notEqual(renewed.id, legacy);
});

test("disconnecting removes every stored Google token of the person, and nobody else's", async () => {
  const store = fakeSessionStore();
  const member = { memoryOwnerId: "member:ana", role: "member" };
  await withEnvironment(FIRESTORE_ENV, async () => {
    resetGoogleSessionsForTests();
    setFirestoreGoogleSessionStoreForTests(store);
    const older = await createSession(tokens("older", `${MAIN} ${YOUTUBE}`), owner);
    const main = await createSession(tokens("main", MAIN), owner);
    const save = await createSession(tokens("save", SAVE), owner, { saveOnly: true });
    assert.equal(await linkSaveSession(main, save), true);
    const theirs = await createSession(tokens("theirs", MAIN, "google-9"), member);
    assert.ok(older);

    const app = express();
    app.use((req, _res, next) => {
      req.owner = owner;
      next();
    });
    app.use("/api/google", googleDriveRouter);
    const server = app.listen(0);
    try {
      const response = await fetch(
        `http://127.0.0.1:${server.address().port}/api/google/disconnect`,
        { method: "POST", headers: { cookie: `synchron_google_session=${main}` } },
      );
      assert.equal(response.status, 200);
    } finally {
      server.close();
    }
    // The older connection does not come back on the next "Свържи Google".
    assert.deepEqual([...store.documents.keys()], [theirs]);
    assert.equal(await latestMainSessionFor(owner), null);
    assert.equal(await getLatestGoogleSessionId(), null);
    assert.equal(await latestMainSessionFor(member), theirs);
    resetGoogleSessionsForTests();
  });
});

async function postDisconnect(cookie) {
  const app = express();
  app.use((req, _res, next) => {
    req.owner = owner;
    next();
  });
  app.use("/api/google", googleDriveRouter);
  const server = app.listen(0);
  try {
    return await fetch(`http://127.0.0.1:${server.address().port}/api/google/disconnect`, {
      method: "POST",
      headers: { cookie },
    });
  } finally {
    server.close();
  }
}

test("disconnecting still removes every token when the store refuses the full scan", async () => {
  const store = fakeSessionStore();
  const member = { memoryOwnerId: "member:ana", role: "member" };
  const listLatest = store.listLatest;
  const scans = [];
  store.listLatest = async (limit = 100) => {
    scans.push(limit);
    if (limit > 100) throw Object.assign(new Error("refused"), { code: "FIRESTORE_UNAVAILABLE", status: 503 });
    return listLatest(limit);
  };
  await withEnvironment(FIRESTORE_ENV, async () => {
    resetGoogleSessionsForTests();
    setFirestoreGoogleSessionStoreForTests(store);
    await createSession(tokens("older", `${MAIN} ${YOUTUBE}`), owner);
    const main = await createSession(tokens("main", MAIN), owner);
    const save = await createSession(tokens("save", SAVE), owner, { saveOnly: true });
    assert.equal(await linkSaveSession(main, save), true);
    const theirs = await createSession(tokens("theirs", MAIN, "google-9"), member);
    resetGoogleSessionsForTests();
    setFirestoreGoogleSessionStoreForTests(store);

    const response = await postDisconnect(`synchron_google_session=${main}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("set-cookie"), /synchron_google_session=;.*Max-Age=0/u);
    assert.ok(scans.includes(1000) && scans.includes(100));
    assert.deepEqual([...store.documents.keys()], [theirs]);
    assert.equal(await latestMainSessionFor(owner), null);
    resetGoogleSessionsForTests();
  });
});

test("when the stored tokens cannot be read, disconnecting removes nothing and says so", async () => {
  const store = fakeSessionStore();
  await withEnvironment(FIRESTORE_ENV, async () => {
    resetGoogleSessionsForTests();
    setFirestoreGoogleSessionStoreForTests(store);
    const older = await createSession(tokens("older", MAIN), owner);
    const main = await createSession(tokens("main", MAIN), owner);
    store.listLatest = async () => {
      throw Object.assign(new Error("unavailable"), { code: "FIRESTORE_UNAVAILABLE", status: 503 });
    };

    const response = await postDisconnect(`synchron_google_session=${main}`);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, "GOOGLE_DISCONNECT_FAILED");
    // The connection stays, so "Прекъсни връзката" is still there to press again.
    assert.equal(response.headers.get("set-cookie"), null);
    assert.deepEqual([...store.documents.keys()].sort(), [main, older].sort());
    resetGoogleSessionsForTests();
  });
});

test("a connection removed on another server instance does not come back from memory", async () => {
  const store = fakeSessionStore();
  await withEnvironment(FIRESTORE_ENV, async () => {
    resetGoogleSessionsForTests();
    setFirestoreGoogleSessionStoreForTests(store);
    await createSession(tokens("older", MAIN), owner);
    const newer = await createSession(tokens("newer", MAIN), owner);
    assert.equal(await latestMainSessionFor(owner), newer);
    // Another instance disconnected: only the stored copies are gone.
    store.documents.clear();
    assert.equal(await latestMainSessionFor(owner), null);
    assert.equal(await getLatestGoogleSessionId(), null);
    resetGoogleSessionsForTests();
  });
});

test("the callback keeps the main connection for a save step and for a partial grant", async () => {
  resetGoogleSessionsForTests();
  const main = await createSession(tokens("main", `${MAIN} ${YOUTUBE}`), owner);
  const app = express();
  app.use((req, _res, next) => {
    req.owner = owner;
    next();
  });
  app.use("/api/google", googleDriveRouter);
  const server = app.listen(0);
  const realFetch = globalThis.fetch;
  let granted = SAVE;
  globalThis.fetch = async (url, init) =>
    String(url) === "https://oauth2.googleapis.com/token"
      ? new Response(JSON.stringify(tokens("granted", granted)), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      : realFetch(url, init);
  const callback = (state) =>
    realFetch(
      `http://127.0.0.1:${server.address().port}/api/google/callback?code=c&state=${encodeURIComponent(state)}`,
      {
        redirect: "manual",
        headers: { cookie: `synchron_google_session=${main}; synchron_google_state=${state}` },
      },
    );
  try {
    await withEnvironment(
      {
        GOOGLE_CLIENT_ID: "client",
        GOOGLE_CLIENT_SECRET: "secret",
        GOOGLE_REDIRECT_URI: "https://example.test/api/google/callback",
      },
      async () => {
        const saved = await callback("save.n1");
        assert.equal(saved.status, 302);
        assert.equal(saved.headers.get("location"), "/?google=connected");
        assert.ok(saved.headers.get("set-cookie").includes(`synchron_google_session=${main};`));
        assert.notEqual(await saveSessionFor(main), main);
        assert.equal(await getLatestGoogleSessionId(), main);

        // YouTube left unticked on a renewal: the old connection stays.
        granted = MAIN;
        const partial = await callback("n2");
        assert.equal(partial.headers.get("location"), "/?google=partial");
        assert.ok(partial.headers.get("set-cookie").includes(`synchron_google_session=${main};`));
      },
    );
  } finally {
    globalThis.fetch = realFetch;
    server.close();
  }
});

test("the YouTube upload step gets its own linked token, like saving", async () => {
  const UPLOAD = "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/youtube.upload";
  assert.equal(linkedGrantKind(UPLOAD), "publish");
  assert.equal(linkedGrantKind(SAVE), "save");
  assert.equal(linkedGrantKind(`${MAIN} ${YOUTUBE}`), "");

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
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) =>
    String(url) === "https://oauth2.googleapis.com/token"
      ? new Response(JSON.stringify(tokens("upload", UPLOAD)), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      : realFetch(url, init);
  try {
    await withEnvironment(
      {
        GOOGLE_CLIENT_ID: "client",
        GOOGLE_CLIENT_SECRET: "secret",
        GOOGLE_REDIRECT_URI: "https://example.test/api/google/callback",
      },
      async () => {
        const cookie = `synchron_google_session=${main}`;
        const start = await realFetch(`${base}/connect?add=publish`, {
          redirect: "manual",
          headers: { cookie },
        });
        const location = new URL(start.headers.get("location"));
        assert.deepEqual(location.searchParams.get("scope").split(" "), [
          "openid",
          "email",
          "https://www.googleapis.com/auth/youtube.upload",
        ]);
        assert.equal(location.searchParams.get("include_granted_scopes"), null);
        const state = location.searchParams.get("state");
        assert.ok(state.startsWith("publish."));

        const done = await realFetch(
          `${base}/callback?code=c&state=${encodeURIComponent(state)}`,
          { redirect: "manual", headers: { cookie: `${cookie}; synchron_google_state=${state}` } },
        );
        assert.equal(done.headers.get("location"), "/?google=connected");
        assert.ok(done.headers.get("set-cookie").includes(`synchron_google_session=${main};`));
      },
    );
  } finally {
    globalThis.fetch = realFetch;
    server.close();
  }
  const upload = await publishSessionFor(main);
  assert.ok(upload && upload !== main);
  assert.equal(await saveSessionFor(main), main);
  assert.equal(await getLatestGoogleSessionId(), main);
  assert.deepEqual(await grantedExtras(main), ["youtube"]);

  // A renewal keeps the upload step; "Прекъсни връзката" removes it.
  const { id: renewed } = await finishGoogleConnection(tokens("renewed", `${MAIN} ${YOUTUBE}`), owner, {
    previousId: main,
  });
  assert.equal(await publishSessionFor(renewed), upload);
  await disconnectGoogleAccount(renewed, owner);
  assert.equal(await hasSession(upload), false);
  assert.equal(await hasSession(main), false);
});
