import assert from "node:assert/strict";
import test from "node:test";
import {
  getDigitalOceanAppStatus,
  listDigitalOceanEnvironmentVariables,
} from "../src/services/digitalOceanService.js";

test("DigitalOcean environment inventory returns metadata without values", () => {
  const inventory = listDigitalOceanEnvironmentVariables({
    name: "sunchron-backend",
    envs: [
      {
        key: "APP_LEVEL",
        scope: "RUN_TIME",
        type: "GENERAL",
        value: "visible-value",
      },
    ],
    services: [
      {
        name: "web",
        envs: [
          {
            key: "OPENAI_API_KEY",
            scope: "RUN_TIME",
            type: "SECRET",
            value: "super-secret",
          },
        ],
      },
    ],
  });

  assert.deepEqual(inventory, [
    {
      key: "APP_LEVEL",
      scope: "RUN_TIME",
      type: "GENERAL",
      sourceKind: "app",
      sourceName: "sunchron-backend",
    },
    {
      key: "OPENAI_API_KEY",
      scope: "RUN_TIME",
      type: "SECRET",
      sourceKind: "service",
      sourceName: "web",
    },
  ]);
  assert.equal(JSON.stringify(inventory).includes("visible-value"), false);
  assert.equal(JSON.stringify(inventory).includes("super-secret"), false);
});

test("DigitalOcean app status exposes only safe environment metadata", async () => {
  const responses = new Map([
    [
      "/apps/app-1",
      {
        app: {
          id: "app-1",
          spec: {
            name: "sunchron-backend",
            services: [
              {
                name: "web",
                envs: [
                  {
                    key: "MCP_ACCESS_TOKEN",
                    scope: "RUN_TIME",
                    type: "SECRET",
                    value: "must-not-leak",
                  },
                ],
              },
            ],
          },
        },
      },
    ],
    ["/apps/app-1/deployments?page=1&per_page=5", { deployments: [] }],
  ]);
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/^\/v2/, "") + parsed.search;
    return {
      ok: true,
      json: async () => responses.get(path),
    };
  };

  const status = await getDigitalOceanAppStatus({
    env: {
      DIGITALOCEAN_API_TOKEN: "token",
      DIGITALOCEAN_APP_ID: "app-1",
    },
    fetchImpl,
  });

  assert.equal(status.environmentVariables[0].key, "MCP_ACCESS_TOKEN");
  assert.equal(status.environmentVariables[0].type, "SECRET");
  assert.equal(JSON.stringify(status).includes("must-not-leak"), false);
});
