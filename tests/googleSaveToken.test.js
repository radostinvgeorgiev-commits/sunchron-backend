import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";
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
  setGoogleRevokeTimeoutForTests,
} from "../src/services/googleDriveService.js";
import googleDriveRouter from "../src/routes/googleDriveRouter.js";

// "Прекъсни връзката" also revokes AI CORE's access at Google. These tests
// never reach Google: they record which tokens would be revoked.
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const passThroughFetch = globalThis.fetch;
const revokedTokens = [];
const revokeRequests = [];
let revokeAnswer = 200;
let onRevoke = async () => {};
globalThis.fetch = async (url, init) => {
  if (String(url) !== GOOGLE_REVOKE_URL) return passThroughFetch(url, init);
  revokeRequests.push(init);
  revokedTokens.push(new URLSearchParams(String(init?.body || "")).get("token"));
  await onRevoke();
  if (revokeAnswer === "unreachable") throw new TypeError("fetch failed");
  if (revokeAnswer === "timeout") throw new DOMException("timed out", "TimeoutError");
  if (revokeAnswer === "hang") {
    // Google never answers: only the request's own time limit ends it.
    await new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    });
  }
  return new Response("{}", { status: revokeAnswer });
};

function resetRevokes() {
  revokedTokens.length = 0;
  revokeRequests.length = 0;
  revokeAnswer = 200;
  onRevoke = async () => {};
  setGoogleRevokeTimeoutForTests(null);
}

// Everything written to the console while `callback` runs.
async function consoleOutput(callback) {
  const output = [];
  const methods = ["error", "warn", "log", "info"];
  const saved = methods.map((method) => console[method]);
  for (const method of methods) console[method] = (...args) => output.push(args);
  try {
    await callback();
  } finally {
    methods.forEach((method, index) => {
      console[method] = saved[index];
    });
  }
  return output;
}

const consoleText = (output) =>
  output
    .map((args) => args.map((value) => (typeof value === "string" ? value : inspect(value))).join(" "))
    .join("\n");

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
// A connection as Google gives it on the first consent, with a refresh token.
const fullTokens = (name, scope, sub = "google-1") => ({
  ...tokens(name, scope, sub),
  refresh_token: `${name}-refresh`,
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
  resetRevokes();
  // How many tokens were still stored when Google answered each revoke.
  const storedAtAnswer = [];
  onRevoke = async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    storedAtAnswer.push(store.documents.size);
  };
  await withEnvironment(FIRESTORE_ENV, async () => {
    resetGoogleSessionsForTests();
    setFirestoreGoogleSessionStoreForTests(store);
    const older = await createSession(fullTokens("older", `${MAIN} ${YOUTUBE}`), owner);
    const main = await createSession(fullTokens("main", MAIN), owner);
    const save = await createSession(fullTokens("save", SAVE), owner, { saveOnly: true });
    assert.equal(await linkSaveSession(main, save), true);
    const theirs = await createSession(fullTokens("theirs", MAIN, "google-9"), member);
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
    // AI CORE's access is revoked at Google too, once per token of this
    // person (the long-lived refresh token, which ends the whole grant);
    // the other person's token is not touched.
    assert.deepEqual(revokedTokens.sort(), ["main-refresh", "older-refresh", "save-refresh"]);
    for (const init of revokeRequests) {
      assert.equal(init.method, "POST");
      assert.equal(init.headers["Content-Type"], "application/x-www-form-urlencoded");
      // A slow Google cannot hold the button forever.
      assert.ok(init.signal instanceof AbortSignal);
    }
    // Google answered every revoke while all four tokens were still stored:
    // the tokens are revoked first and removed only after Google answers.
    assert.deepEqual(storedAtAnswer, [4, 4, 4]);
    resetGoogleSessionsForTests();
  });
  resetRevokes();
});

// A Google that never answers must not hold the test (or the button) forever.
test("a revoke that Google refuses or never answers still disconnects", { timeout: 10_000 }, async () => {
  // What is logged for each answer: only its kind, once per token, and
  // never a token.
  const failure = (metadata) => ["[Google disconnect] Revoke failure", metadata];
  const logged = {
    400: [],
    503: [failure({ name: "Error", status: 503 }), failure({ name: "Error", status: 503 })],
    unreachable: [failure({ name: "TypeError" }), failure({ name: "TypeError" })],
    timeout: [failure({ name: "TimeoutError" }), failure({ name: "TimeoutError" })],
    hang: [failure({ name: "TimeoutError" }), failure({ name: "TimeoutError" })],
  };
  for (const [answer, expected] of Object.entries(logged)) {
    const store = fakeSessionStore();
    resetRevokes();
    revokeAnswer = Number(answer) || answer;
    // A Google that never answers is given up on after the time limit.
    setGoogleRevokeTimeoutForTests(50);
    try {
      const output = await consoleOutput(() =>
        withEnvironment(FIRESTORE_ENV, async () => {
          resetGoogleSessionsForTests();
          setFirestoreGoogleSessionStoreForTests(store);
          await createSession(tokens("ya29.secret-older", MAIN), owner);
          const main = await createSession(tokens("ya29.secret-main", MAIN), owner);
          const response = await callGoogle("/disconnect", `synchron_google_session=${main}`);
          assert.equal(response.status, 200, `revoke answer ${answer}`);
          assert.equal(store.documents.size, 0);
          // Without a refresh token the access token is revoked.
          assert.deepEqual(revokedTokens.sort(), ["ya29.secret-main", "ya29.secret-older"]);
          resetGoogleSessionsForTests();
        }),
      );
      // A 400 means the token is already dead: nothing at all is written.
      assert.deepEqual(
        output.map(([context, metadata]) => [context, { ...metadata }]),
        expected,
        `revoke answer ${answer}`,
      );
      assert.doesNotMatch(consoleText(output), /secret/u);
    } finally {
      resetRevokes();
    }
  }
});

test("a Google account that someone else still connects here is only forgotten, never revoked", async () => {
  const store = fakeSessionStore();
  const member = { memoryOwnerId: "member:ana", role: "member" };
  resetRevokes();
  await withEnvironment(FIRESTORE_ENV, async () => {
    resetGoogleSessionsForTests();
    setFirestoreGoogleSessionStoreForTests(store);
    // The owner connects two Google accounts; the member connects one of
    // them too. Google keeps one grant per Google account, so revoking it
    // for one person would cut the other person off as well.
    const ownerShared = await createSession(fullTokens("owner-shared", MAIN, "google-1"), owner);
    const ownerOnly = await createSession(fullTokens("owner-only", MAIN, "google-2"), owner);
    // A connection from before the Google account was kept cannot be checked.
    const { id_token: _unknown, ...legacyTokens } = fullTokens("owner-legacy", MAIN);
    await createSession(legacyTokens, owner);
    const memberMain = await createSession(fullTokens("member-main", MAIN, "google-1"), member);

    const first = await callGoogle("/disconnect", `synchron_google_session=${ownerOnly}`);
    assert.equal(first.status, 200);
    // Only the account nobody else uses is revoked; every token of the
    // owner is gone here, and the member keeps their connection.
    assert.deepEqual(revokedTokens, ["owner-only-refresh"]);
    assert.deepEqual([...store.documents.keys()], [memberMain]);
    assert.equal(await latestMainSessionFor(owner), null);
    assert.equal(await latestMainSessionFor(member), memberMain);
    assert.ok(ownerShared);

    // Now nobody else uses the member's Google account: it is revoked.
    revokedTokens.length = 0;
    const second = await callGoogle(
      "/disconnect",
      `synchron_google_session=${memberMain}`,
      "POST",
      member,
    );
    assert.equal(second.status, 200);
    assert.deepEqual(revokedTokens, ["member-main-refresh"]);
    assert.equal(store.documents.size, 0);
    resetGoogleSessionsForTests();
  });
  resetRevokes();
});

test("a member who disconnects never revokes the Google account the owner still uses", async () => {
  const store = fakeSessionStore();
  const member = { memoryOwnerId: "member:ana", role: "member" };
  resetRevokes();
  await withEnvironment(FIRESTORE_ENV, async () => {
    resetGoogleSessionsForTests();
    setFirestoreGoogleSessionStoreForTests(store);
    const ownerMain = await createSession(fullTokens("owner-main", MAIN, "google-1"), owner);
    const memberMain = await createSession(fullTokens("member-main", MAIN, "google-1"), member);
    const memberSave = await createSession(fullTokens("member-save", SAVE, "google-1"), member, {
      saveOnly: true,
    });
    assert.equal(await linkSaveSession(memberMain, memberSave), true);

    const response = await callGoogle(
      "/disconnect",
      `synchron_google_session=${memberMain}`,
      "POST",
      member,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(revokedTokens, []);
    assert.deepEqual([...store.documents.keys()], [ownerMain]);
    assert.equal(await latestMainSessionFor(member), null);
    assert.equal(await latestMainSessionFor(owner), ownerMain);
    resetGoogleSessionsForTests();
  });
  resetRevokes();
});

test("a member's disconnect never revokes the Google account of an older owner connection", async () => {
  const store = fakeSessionStore();
  const member = { memoryOwnerId: "member:ana", role: "member" };
  resetRevokes();
  await withEnvironment(FIRESTORE_ENV, async () => {
    resetGoogleSessionsForTests();
    setFirestoreGoogleSessionStoreForTests(store);
    // Made before connections had an account: it belongs to the owner.
    const legacy = await createSession(fullTokens("legacy", MAIN, "google-1"));
    const memberMain = await createSession(fullTokens("member-main", MAIN, "google-1"), member);
    const response = await callGoogle(
      "/disconnect",
      `synchron_google_session=${memberMain}`,
      "POST",
      member,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(revokedTokens, []);
    assert.deepEqual([...store.documents.keys()], [legacy]);
    resetGoogleSessionsForTests();
  });
  resetRevokes();
});

test("a connection another server instance already removed does not stop the revoke", async () => {
  const store = fakeSessionStore();
  const member = { memoryOwnerId: "member:ana", role: "member" };
  resetRevokes();
  await withEnvironment(FIRESTORE_ENV, async () => {
    resetGoogleSessionsForTests();
    setFirestoreGoogleSessionStoreForTests(store);
    const ownerMain = await createSession(fullTokens("owner-main", MAIN, "google-1"), owner);
    const memberMain = await createSession(fullTokens("member-main", MAIN, "google-1"), member);
    // The member disconnected on another instance: this instance still
    // has a copy in memory, but the stored copy is gone.
    store.documents.delete(memberMain);
    assert.equal(await hasSession(memberMain), true);

    const response = await callGoogle("/disconnect", `synchron_google_session=${ownerMain}`);
    assert.equal(response.status, 200);
    assert.deepEqual(revokedTokens, ["owner-main-refresh"]);
    assert.equal(store.documents.size, 0);
    resetGoogleSessionsForTests();
  });
  resetRevokes();
});

test("when it cannot be told who else uses a Google account, nothing is revoked, only forgotten", async () => {
  const member = { memoryOwnerId: "member:ana", role: "member" };
  for (const reason of ["the stored list is cut at its limit", "someone else's account is unknown"]) {
    const store = fakeSessionStore();
    resetRevokes();
    await withEnvironment(FIRESTORE_ENV, async () => {
      resetGoogleSessionsForTests();
      setFirestoreGoogleSessionStoreForTests(store);
      const kept = [];
      if (reason === "someone else's account is unknown") {
        const { id_token: _unknown, ...unknownTokens } = fullTokens("member-old", MAIN);
        kept.push(await createSession(unknownTokens, member));
      } else {
        // The store answers with as many connections as it was asked for,
        // so someone else's connection may be missing from the answer.
        const listLatest = store.listLatest;
        store.listLatest = async (limit = 100) => {
          const found = await listLatest(limit);
          const filler = Array.from({ length: Math.max(0, limit - found.length) }, (_, index) => ({
            id: `not-listed-${index}`,
            payload: "unreadable",
          }));
          return [...found, ...filler];
        };
      }
      const main = await createSession(fullTokens("main", MAIN, "google-1"), owner);
      const response = await callGoogle("/disconnect", `synchron_google_session=${main}`);
      assert.equal(response.status, 200, reason);
      assert.deepEqual(revokedTokens, [], reason);
      // The person is still disconnected here.
      assert.deepEqual([...store.documents.keys()], kept, reason);
      assert.equal(await latestMainSessionFor(owner), null, reason);
      resetGoogleSessionsForTests();
    });
  }
  resetRevokes();
});

async function callGoogle(path, cookie, method = "POST", person = owner) {
  const app = express();
  app.use((req, _res, next) => {
    req.owner = person;
    next();
  });
  app.use("/api/google", googleDriveRouter);
  const server = app.listen(0);
  try {
    return await fetch(`http://127.0.0.1:${server.address().port}/api/google${path}`, {
      method,
      headers: { cookie },
    });
  } finally {
    server.close();
  }
}

test("a delete that fails on the way keeps this browser's connection, so Disconnect can be pressed again", async () => {
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
    const remove = store.delete;
    let failOnce = true;
    store.delete = async (id) => {
      if (id === older && failOnce) {
        failOnce = false;
        throw Object.assign(new Error("unavailable"), { code: "FIRESTORE_UNAVAILABLE", status: 503 });
      }
      return remove(id);
    };
    const cookie = `synchron_google_session=${main}`;

    const failed = await callGoogle("/disconnect", cookie);
    assert.equal(failed.status, 503);
    assert.equal(failed.headers.get("set-cookie"), null);
    assert.equal((await (await callGoogle("/status", cookie, "GET")).json()).connected, true);

    const again = await callGoogle("/disconnect", cookie);
    assert.equal(again.status, 200);
    assert.match(again.headers.get("set-cookie"), /synchron_google_session=;.*Max-Age=0/u);
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

    resetRevokes();
    const response = await callGoogle("/disconnect", `synchron_google_session=${main}`);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, "GOOGLE_DISCONNECT_FAILED");
    // Nothing is revoked at Google when the stored tokens cannot be read.
    assert.deepEqual(revokedTokens, []);
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
