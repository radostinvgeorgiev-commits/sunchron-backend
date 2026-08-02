import assert from "node:assert/strict";
import test from "node:test";

import {
  activateDigitalOceanDomainAlias,
  activateTesterAuthConfiguration,
  addDigitalOceanDomainAlias,
  addTesterAuthEnvironmentVariables,
  DigitalOceanError,
  inspectDigitalOceanDomainAlias,
  inspectTesterAuthActivation,
  missingTesterAuthEnvironmentKeys,
  TESTER_AUTH_ENV_KEYS,
} from "../src/services/digitalOceanService.js";

const PROJECT_URL = "https://projectref.supabase.co";
const PUBLISHABLE_KEY = "sb_publishable_abcdefghijklmnopqrstuvwxyz";
const APP_ID = "6e6fdc40-2ef5-4534-8906-8a6414b089b5";

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
  };
}

test("adds only the approved www domain and preserves the current spec", () => {
  const current = {
    name: "synchron",
    domains: [{ domain: "synchron.foundation", type: "PRIMARY" }],
    services: [{ name: "web", run_command: "npm start" }],
  };
  const result = addDigitalOceanDomainAlias(current);

  assert.equal(result.added, true);
  assert.deepEqual(current.domains, [
    { domain: "synchron.foundation", type: "PRIMARY" },
  ]);
  assert.deepEqual(result.spec.domains, [
    { domain: "synchron.foundation", type: "PRIMARY" },
    { domain: "www.synchron.foundation", type: "ALIAS" },
  ]);
  assert.deepEqual(result.spec.services, current.services);
  assert.throws(
    () => addDigitalOceanDomainAlias(current, "other.example.com"),
    (error) =>
      error instanceof DigitalOceanError &&
      error.code === "DIGITALOCEAN_DOMAIN_NOT_ALLOWED",
  );
});

test("inspects and updates the www domain with one safe app-spec write", async () => {
  const calls = [];
  const currentSpec = {
    name: "synchron",
    domains: [{ domain: "synchron.foundation", type: "PRIMARY" }],
    envs: [
      {
        key: "EXISTING_SECRET",
        scope: "RUN_TIME",
        type: "SECRET",
        value: "EV[1:preserved]",
      },
    ],
    services: [{ name: "web", run_command: "npm start" }],
  };
  const fetchImpl = async (_url, options) => {
    calls.push(options);
    if (options.method === "GET") {
      return jsonResponse(200, {
        app: { id: APP_ID, spec: currentSpec },
      });
    }
    return jsonResponse(200, {
      app: { id: APP_ID, in_progress_deployment: { id: "deploy-www" } },
    });
  };
  const env = {
    DIGITALOCEAN_API_TOKEN: "do-token",
    DIGITALOCEAN_APP_ID: APP_ID,
  };

  const inspection = await inspectDigitalOceanDomainAlias({ env, fetchImpl });
  assert.equal(inspection.configured, false);
  assert.deepEqual(inspection.currentDomains, [
    { domain: "synchron.foundation", type: "PRIMARY" },
  ]);

  const result = await activateDigitalOceanDomainAlias({
    expectedAppId: APP_ID,
    env,
    fetchImpl,
  });
  assert.equal(result.updated, true);
  assert.equal(result.domain, "www.synchron.foundation");
  assert.equal(result.deploymentId, "deploy-www");
  assert.equal(calls.length, 3);
  const submitted = JSON.parse(calls[2].body).spec;
  assert.deepEqual(submitted.domains, [
    { domain: "synchron.foundation", type: "PRIMARY" },
    { domain: "www.synchron.foundation", type: "ALIAS" },
  ]);
  assert.equal(submitted.envs[0].value, "EV[1:preserved]");
  assert.doesNotMatch(calls[2].body, /do-token/u);
});

test("does not write when the www domain is already configured", async () => {
  const methods = [];
  const result = await activateDigitalOceanDomainAlias({
    env: {
      DIGITALOCEAN_API_TOKEN: "do-token",
      DIGITALOCEAN_APP_ID: APP_ID,
    },
    fetchImpl: async (_url, options) => {
      methods.push(options.method);
      return jsonResponse(200, {
        app: {
          id: APP_ID,
          spec: {
            name: "synchron",
            domains: [{ domain: "www.synchron.foundation", type: "ALIAS" }],
          },
        },
      });
    },
  });

  assert.equal(result.updated, false);
  assert.deepEqual(methods, ["GET"]);
});

test("resolves the public app safely when DIGITALOCEAN_APP_ID is not a UUID", async () => {
  const paths = [];
  const result = await inspectDigitalOceanDomainAlias({
    env: {
      DIGITALOCEAN_API_TOKEN: "do-token",
      DIGITALOCEAN_APP_ID: "sunchron-backend",
    },
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      paths.push(`${parsed.pathname}${parsed.search}`);
      if (parsed.pathname === "/v2/apps") {
        return jsonResponse(200, {
          apps: [
            {
              id: APP_ID,
              spec: {
                name: "sunchron-backend",
                domains: [{ domain: "synchron.foundation", type: "PRIMARY" }],
              },
            },
          ],
        });
      }
      return jsonResponse(200, {
        app: {
          id: APP_ID,
          spec: {
            name: "sunchron-backend",
            domains: [{ domain: "synchron.foundation", type: "PRIMARY" }],
          },
        },
      });
    },
  });

  assert.equal(result.appId, APP_ID);
  assert.equal(result.configured, false);
  assert.deepEqual(paths, ["/v2/apps?per_page=200", `/v2/apps/${APP_ID}`]);
});

test("fails closed when automatic DigitalOcean app resolution is ambiguous", async () => {
  await assert.rejects(
    inspectDigitalOceanDomainAlias({
      env: {
        DIGITALOCEAN_API_TOKEN: "do-token",
        DIGITALOCEAN_APP_ID: "not-a-uuid",
      },
      fetchImpl: async () =>
        jsonResponse(200, {
          apps: [
            { id: APP_ID, spec: { name: "sunchron-backend" } },
            {
              id: "ee8c9caf-1111-4222-8333-0123456789ab",
              spec: { name: "sunchron-backend" },
            },
          ],
        }),
    }),
    (error) =>
      error instanceof DigitalOceanError &&
      error.code === "DIGITALOCEAN_APP_RESOLUTION_AMBIGUOUS",
  );
});

test("adds only the missing tester-auth variables at app level", () => {
  const current = {
    name: "synchron",
    envs: [
      {
        key: "SUPABASE_URL",
        scope: "RUN_TIME",
        type: "SECRET",
        value: "EV[1:existing]",
      },
    ],
    services: [{ name: "web", envs: [{ key: "OPENAI_API_KEY" }] }],
  };
  const result = addTesterAuthEnvironmentVariables(current, {
    projectUrl: PROJECT_URL,
    publishableKey: PUBLISHABLE_KEY,
    sessionEncryptionKey: "session-secret",
    inviteCode: "invite-code",
  });

  assert.deepEqual(result.missingKeys, TESTER_AUTH_ENV_KEYS.slice(1));
  assert.equal(current.envs.length, 1);
  assert.deepEqual(result.spec.services, current.services);
  for (const key of result.missingKeys) {
    const item = result.spec.envs.find((entry) => entry.key === key);
    assert.equal(item.scope, "RUN_TIME");
    assert.equal(item.type, "SECRET");
  }
  assert.equal(
    result.spec.envs.filter(({ key }) => key === "SUPABASE_URL").length,
    1,
  );
});

test("updates the exact DigitalOcean app spec without returning the session key", async () => {
  const calls = [];
  let randomCall = 0;
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    calls.push({ path: parsed.pathname, options });
    if (options.method === "GET") {
      return {
        ok: true,
        async json() {
          return {
            app: {
              id: "app-1",
              spec: {
                name: "synchron",
                envs: [
                  {
                    key: "EXISTING_SECRET",
                    scope: "RUN_TIME",
                    type: "SECRET",
                    value: "EV[1:preserved]",
                  },
                ],
                services: [{ name: "web", run_command: "npm start" }],
              },
            },
          };
        },
      };
    }
    return {
      ok: true,
      async json() {
        return {
          app: { id: "app-1", in_progress_deployment: { id: "deploy-1" } },
        };
      },
    };
  };

  const result = await activateTesterAuthConfiguration({
    projectUrl: PROJECT_URL,
    publishableKey: PUBLISHABLE_KEY,
    expectedAppId: "app-1",
    env: {
      DIGITALOCEAN_API_TOKEN: "do-token",
      DIGITALOCEAN_APP_ID: "app-1",
    },
    fetchImpl,
    randomBytesImpl(size) {
      randomCall += 1;
      return Buffer.alloc(size, randomCall);
    },
  });

  assert.equal(result.updated, true);
  assert.deepEqual(result.changedKeys, TESTER_AUTH_ENV_KEYS);
  assert.equal(result.deploymentId, "deploy-1");
  assert.equal(typeof result.inviteCode, "string");
  assert.equal("sessionEncryptionKey" in result, false);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[1].options.method, "PUT");
  const submitted = JSON.parse(calls[1].options.body);
  assert.equal(submitted.spec.services[0].run_command, "npm start");
  assert.equal(
    submitted.spec.envs.find(({ key }) => key === "EXISTING_SECRET").value,
    "EV[1:preserved]",
  );
  assert.deepEqual(missingTesterAuthEnvironmentKeys(submitted.spec), []);
  assert.doesNotMatch(calls[1].options.body, /do-token/u);
});

test("refuses to round-trip a redacted existing DigitalOcean secret", async () => {
  let putCalled = false;
  const fetchImpl = async (_url, options) => {
    if (options.method === "PUT") putCalled = true;
    return {
      ok: true,
      async json() {
        return {
          app: {
            id: "app-1",
            spec: {
              name: "synchron",
              envs: [
                {
                  key: "EXISTING_SECRET",
                  scope: "RUN_TIME",
                  type: "SECRET",
                },
              ],
            },
          },
        };
      },
    };
  };

  await assert.rejects(
    activateTesterAuthConfiguration({
      projectUrl: PROJECT_URL,
      publishableKey: PUBLISHABLE_KEY,
      env: {
        DIGITALOCEAN_API_TOKEN: "do-token",
        DIGITALOCEAN_APP_ID: "app-1",
      },
      fetchImpl,
    }),
    (error) =>
      error instanceof DigitalOceanError &&
      error.code === "DIGITALOCEAN_SECRET_ROUND_TRIP_UNSAFE",
  );
  assert.equal(putCalled, false);
});

test("inspects tester auth safely before any write", async () => {
  const methods = [];
  const result = await inspectTesterAuthActivation({
    projectUrl: PROJECT_URL,
    publishableKey: PUBLISHABLE_KEY,
    env: {
      DIGITALOCEAN_API_TOKEN: "do-token",
      DIGITALOCEAN_APP_ID: "app-1",
    },
    fetchImpl: async (_url, options) => {
      methods.push(options.method);
      return jsonResponse(200, {
        app: { id: "app-1", spec: { name: "synchron", envs: [] } },
      });
    },
  });

  assert.deepEqual(methods, ["GET"]);
  assert.equal(result.readAccessVerified, true);
  assert.equal(result.requiredWriteScope, "app:update");
  assert.equal(result.writeAccess, "verified-on-update");
  assert.deepEqual(result.missingKeys, TESTER_AUTH_ENV_KEYS);
});

test("reports an actionable app:update error without leaking tokens", async () => {
  let call = 0;
  await assert.rejects(
    activateTesterAuthConfiguration({
      projectUrl: PROJECT_URL,
      publishableKey: PUBLISHABLE_KEY,
      env: {
        DIGITALOCEAN_API_TOKEN: "do-token",
        DIGITALOCEAN_APP_ID: "app-1",
      },
      fetchImpl: async (_url, options) => {
        call += 1;
        if (options.method === "GET") {
          return jsonResponse(200, {
            app: { id: "app-1", spec: { name: "synchron", envs: [] } },
          });
        }
        return jsonResponse(403, {
          id: "forbidden",
          message:
            "Token dop_v1_secretvalue has no access for the attempted action.",
        });
      },
    }),
    (error) => {
      assert.equal(error.code, "DIGITALOCEAN_APP_UPDATE_FORBIDDEN");
      assert.equal(error.status, 403);
      assert.match(error.message, /app:update/u);
      assert.doesNotMatch(error.message, /dop_v1_secretvalue/u);
      assert.match(error.message, /\[скрит токен\]/u);
      return true;
    },
  );
  assert.equal(call, 2);
});
