import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import router from "../src/routes/userAuthRouter.js";
import { setFirestoreTesterAccessStoreForTests } from "../src/services/testerAccessService.js";

test("registration, verification and login create an isolated member session", async () => {
  const config = {
    AUTH_BACKEND: "identity-platform",
    IDENTITY_PLATFORM_PROJECT_ID: "test-project-id",
    IDENTITY_PLATFORM_API_KEY: "test-api-key-for-local-tests",
    USER_SESSION_ENCRYPTION_KEY: "test-session-key-for-local-tests",
    USER_REGISTRATION_MODE: "public",
    PERSISTENCE_BACKEND: "firestore",
  };
  const old = Object.fromEntries(
    Object.keys(config).map((key) => [key, process.env[key]]),
  );
  const originalFetch = globalThis.fetch;
  const records = new Map();
  let verified = false;
  let sent = false;
  try {
    Object.assign(process.env, config);
    setFirestoreTesterAccessStoreForTests({
      async set(id, data) {
        records.set(id, data);
      },
      async get(id) {
        return records.has(id) ? { id, data: records.get(id) } : null;
      },
    });

    globalThis.fetch = async (url) => {
      const path = new URL(url).pathname;
      const account = {
        localId: "local-user",
        email: "customer@example.test",
        idToken: "test-id",
        refreshToken: "test-refresh",
        expiresIn: "3600",
      };
      if (
        path.endsWith("accounts:signUp") ||
        path.endsWith("accounts:update") ||
        path.endsWith("accounts:signInWithPassword")
      )
        return Response.json(account);
      if (path.endsWith("accounts:lookup"))
        return Response.json({
          users: [{ ...account, emailVerified: verified }],
        });
      if (path.endsWith("accounts:sendOobCode")) {
        sent = true;
        return Response.json({});
      }
      throw new Error("unexpected request");
    };
    const app = express();
    app.use(express.json());
    app.use("/api/auth", router);
    const credentials = {
      email: "customer@example.test",
      password: "local-password",
      displayName: "Test",
    };
    const registration = await request(app)
      .post("/api/auth/register")
      .send(credentials)
      .expect(201);
    assert.equal(registration.body.confirmationRequired, true);
    assert.equal(registration.headers["set-cookie"], undefined);
    assert.equal(sent, true);
    assert.equal(
      records.get("identity-platform:local-user").status,
      "approved",
    );
    await request(app).post("/api/auth/login").send(credentials).expect(403);
    verified = true;
    const login = await request(app)
      .post("/api/auth/login")
      .send(credentials)
      .expect(200);
    assert.match(
      login.headers["set-cookie"][0],
      /HttpOnly; Secure; SameSite=Lax/u,
    );
    const session = await request(app)
      .get("/api/auth/session")
      .set("Cookie", login.headers["set-cookie"])
      .expect(200);
    assert.equal(session.body.authenticated, true);
    assert.equal(session.body.user.role, "member");
  } finally {
    globalThis.fetch = originalFetch;
    setFirestoreTesterAccessStoreForTests(null);
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("identity errors reach the browser with safe codes and request-correlated logs", async () => {
  const config = {
    AUTH_BACKEND: "identity-platform",
    IDENTITY_PLATFORM_PROJECT_ID: "test-project-id",
    IDENTITY_PLATFORM_API_KEY: "test-api-key-for-local-tests",
    USER_SESSION_ENCRYPTION_KEY: "test-session-key-for-local-tests",
    USER_REGISTRATION_MODE: "public",
  };
  const old = Object.fromEntries(
    Object.keys(config).map((key) => [key, process.env[key]]),
  );
  const originalFetch = globalThis.fetch;
  const originalLog = console.info;
  const logs = [];
  try {
    Object.assign(process.env, config);
    console.info = (line) => logs.push(line);
    const app = express();
    app.use(express.json());
    app.use("/api/auth", router);
    for (const [upstream, expected] of [
      ["API_KEY_INVALID", "auth/invalid-api-key"],
      ["INVALID_DOMAIN", "auth/unauthorized-domain"],
      ["EMAIL_EXISTS", "auth/email-already-in-use"],
      ["WEAK_PASSWORD", "auth/weak-password"],
    ]) {
      globalThis.fetch = async () =>
        Response.json(
          {
            error: {
              message:
                upstream === "API_KEY_INVALID"
                  ? "API key is invalid"
                  : upstream,
              details:
                upstream === "API_KEY_INVALID" ? [{ reason: upstream }] : [],
            },
          },
          { status: 400 },
        );
      const response = await request(app).post("/api/auth/register").send({
        email: "private@example.test",
        password: "private-password",
        displayName: "Test",
      });
      assert.equal(response.body.code, expected);
      assert.ok(response.body.error);
      assert.ok(response.headers["x-request-id"]);
      assert.ok(
        logs.some((line) => {
          const event = JSON.parse(line);
          return (
            event.requestId === response.headers["x-request-id"] &&
            event.identityPlatformCode === upstream
          );
        }),
      );
    }
    assert.doesNotMatch(
      logs.join("\n"),
      /private@example\.test|private-password|test-api-key-for-local-tests/u,
    );
  } finally {
    console.info = originalLog;
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
