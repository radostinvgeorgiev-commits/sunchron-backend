import assert from "node:assert/strict";
import test from "node:test";

import {
  activateTesterAuthConfiguration,
  addTesterAuthEnvironmentVariables,
  DigitalOceanError,
  missingTesterAuthEnvironmentKeys,
  TESTER_AUTH_ENV_KEYS,
} from "../src/services/digitalOceanService.js";

const PROJECT_URL = "https://projectref.supabase.co";
const PUBLISHABLE_KEY = "sb_publishable_abcdefghijklmnopqrstuvwxyz";

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
