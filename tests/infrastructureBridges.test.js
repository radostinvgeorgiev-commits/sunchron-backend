import assert from "node:assert/strict";
import test from "node:test";

import {
  getDigitalOceanAccountAudit,
  getDigitalOceanDatabaseBackupInventory,
  getDigitalOceanOpenSearchBackupAudit,
  getDigitalOceanAppStatus,
  formatDigitalOceanAudit,
  formatDigitalOceanOpenSearchBackupAudit,
  formatDigitalOceanStatus,
} from "../src/services/digitalOceanService.js";
import {
  getCloudflareZoneStatus,
  formatCloudflareStatus,
} from "../src/services/cloudflareService.js";
import { detectCapabilityRequests } from "../src/routes/chat.js";

const TEST_APP_ID = "6e6fdc40-2ef5-4534-8906-8a6414b089b5";

test("DigitalOcean bridge reads app and deployment status without writes", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes("/deployments")) {
      return Response.json({
        deployments: [{ id: "dep-1", phase: "ACTIVE", cause: "commit" }],
      });
    }
    return Response.json({
      app: {
        id: TEST_APP_ID,
        spec: { name: "sunchron-backend" },
        live_url: "https://synchron.foundation",
        active_deployment: { id: "dep-1", phase: "ACTIVE" },
      },
    });
  };
  const status = await getDigitalOceanAppStatus({
    env: {
      DIGITALOCEAN_API_TOKEN: "secret",
      DIGITALOCEAN_APP_ID: TEST_APP_ID,
    },
    fetchImpl,
  });
  assert.equal(status.activeDeployment.phase, "ACTIVE");
  assert.match(formatDigitalOceanStatus(status), /sunchron-backend/u);
  assert.equal(calls.length, 2);
  assert.ok(
    calls.every(
      (call) => !call.options.method || call.options.method === "GET",
    ),
  );
  assert.doesNotMatch(JSON.stringify(status), /secret/u);
});

test("DigitalOcean app status resolves a configured app name to its real id", async () => {
  const calls = [];
  const appId = TEST_APP_ID;
  const fetchImpl = async (url) => {
    const parsed = new URL(String(url));
    calls.push(`${parsed.pathname}${parsed.search}`);
    if (parsed.pathname === "/v2/apps") {
      return Response.json({
        apps: [{ id: appId, spec: { name: "sunchron-backend" } }],
      });
    }
    if (parsed.pathname.endsWith("/deployments")) {
      return Response.json({ deployments: [] });
    }
    return Response.json({
      app: {
        id: appId,
        spec: { name: "sunchron-backend" },
        active_deployment: { id: "dep-1", phase: "ACTIVE" },
      },
    });
  };

  const status = await getDigitalOceanAppStatus({
    env: {
      DIGITALOCEAN_API_TOKEN: "secret",
      DIGITALOCEAN_APP_ID: "sunchron-backend",
    },
    fetchImpl,
  });

  assert.equal(status.id, appId);
  assert.deepEqual(calls, [
    "/v2/apps?per_page=200",
    `/v2/apps/${appId}`,
    `/v2/apps/${appId}/deployments?page=1&per_page=5`,
  ]);
  assert.equal(
    calls.some((path) => path.includes("/apps/sunchron-backend")),
    false,
  );
});

test("DigitalOcean app status retries a transient app read", async () => {
  let appCalls = 0;
  const fetchImpl = async (url) => {
    if (String(url).includes("/deployments")) {
      return Response.json({ deployments: [] });
    }
    appCalls += 1;
    if (appCalls === 1) throw new Error("temporary network failure");
    return Response.json({
      app: {
        id: TEST_APP_ID,
        spec: { name: "sunchron-backend" },
        active_deployment: { id: "dep-1", phase: "ACTIVE" },
      },
    });
  };

  const status = await getDigitalOceanAppStatus({
    env: {
      DIGITALOCEAN_API_TOKEN: "secret",
      DIGITALOCEAN_APP_ID: TEST_APP_ID,
    },
    fetchImpl,
    retryDelaysMs: [0],
    sleepImpl: async () => {},
  });

  assert.equal(appCalls, 2);
  assert.equal(status.activeDeployment.phase, "ACTIVE");
  assert.equal(status.deploymentsAvailable, true);
});

test("DigitalOcean app status keeps verified app data when deployment history is temporarily unavailable", async () => {
  let deploymentCalls = 0;
  const fetchImpl = async (url) => {
    if (String(url).includes("/deployments")) {
      deploymentCalls += 1;
      return Response.json({ message: "temporary failure" }, { status: 503 });
    }
    return Response.json({
      app: {
        id: TEST_APP_ID,
        spec: { name: "sunchron-backend" },
        live_url: "https://synchron.foundation",
        active_deployment: { id: "dep-1", phase: "ACTIVE" },
      },
    });
  };

  const status = await getDigitalOceanAppStatus({
    env: {
      DIGITALOCEAN_API_TOKEN: "secret",
      DIGITALOCEAN_APP_ID: TEST_APP_ID,
    },
    fetchImpl,
    retryDelaysMs: [0, 0],
    sleepImpl: async () => {},
  });

  assert.equal(deploymentCalls, 3);
  assert.equal(status.activeDeployment.phase, "ACTIVE");
  assert.equal(status.deploymentsAvailable, false);
  assert.equal(status.deploymentsErrorCode, "DIGITALOCEAN_UPSTREAM_ERROR");
  assert.match(
    formatDigitalOceanStatus(status),
    /основният статус на приложението е проверен/u,
  );
});

test("DigitalOcean app status never hides token errors from deployment history", async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes("/deployments")) {
      return Response.json({ message: "unauthorized" }, { status: 401 });
    }
    return Response.json({ app: { id: TEST_APP_ID, spec: {} } });
  };

  await assert.rejects(
    getDigitalOceanAppStatus({
      env: {
        DIGITALOCEAN_API_TOKEN: "secret",
        DIGITALOCEAN_APP_ID: TEST_APP_ID,
      },
      fetchImpl,
      retryDelaysMs: [0],
      sleepImpl: async () => {},
    }),
    (error) => error.code === "DIGITALOCEAN_TOKEN_INVALID",
  );
});

test("DigitalOcean full audit reads account resources without writes or secrets", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const path = new URL(String(url)).pathname;
    calls.push({ path, options });
    if (path === "/v2/account") {
      return Response.json({
        account: {
          status: "active",
          email_verified: true,
          droplet_limit: 10,
          volume_limit: 10,
        },
      });
    }
    if (path === "/v2/apps") {
      return Response.json({
        apps: [
          {
            id: "app-1",
            spec: { name: "sunchron-backend" },
            active_deployment: { phase: "ACTIVE" },
          },
        ],
      });
    }
    if (path === "/v2/droplets") {
      return Response.json({
        droplets: [
          {
            id: 1,
            name: "api",
            status: "active",
            features: [],
            size_slug: "s-1vcpu-1gb",
            region: { slug: "fra1" },
          },
        ],
      });
    }
    if (path === "/v2/databases") {
      return Response.json({
        databases: [
          {
            id: "db-1",
            name: "memory",
            status: "online",
            engine: "opensearch",
            region: "fra1",
          },
        ],
      });
    }
    if (path === "/v2/databases/db-1/backups") {
      return Response.json({
        backups: [
          { created_at: "2026-07-31T02:00:00Z" },
          { created_at: "2026-07-30T02:00:00Z" },
        ],
      });
    }
    if (path === "/v2/volumes") {
      return Response.json({
        volumes: [
          {
            id: "vol-1",
            name: "data",
            size_gigabytes: 10,
            droplet_ids: [],
            region: { slug: "fra1" },
          },
        ],
      });
    }
    if (path === "/v2/firewalls") {
      return Response.json({ firewalls: [] });
    }
    if (path === "/v2/actions") {
      return Response.json({
        actions: [{ id: 1, status: "errored", type: "deploy" }],
      });
    }
    if (path === "/v2/customers/my/balance") {
      return Response.json({
        month_to_date_usage: "12.34",
        account_balance: "0.00",
        currency: "EUR",
      });
    }
    if (path === "/v2/registry") {
      return Response.json({ registry: null });
    }
    const keyByPath = {
      "/v2/snapshots": "snapshots",
      "/v2/vpcs": "vpcs",
      "/v2/domains": "domains",
      "/v2/load_balancers": "load_balancers",
      "/v2/reserved_ips": "reserved_ips",
      "/v2/kubernetes/clusters": "kubernetes",
      "/v2/certificates": "certificates",
      "/v2/cdn/endpoints": "endpoints",
      "/v2/functions/namespaces": "namespaces",
      "/v2/images": "images",
      "/v2/account/keys": "ssh_keys",
      "/v2/tags": "tags",
      "/v2/uptime/checks": "checks",
      "/v2/projects": "projects",
    };
    return Response.json({ [keyByPath[path]]: [] });
  };
  const audit = await getDigitalOceanAccountAudit({
    env: { DIGITALOCEAN_API_TOKEN: "secret" },
    fetchImpl,
  });
  assert.equal(audit.account.status, "active");
  assert.equal(audit.apps.length, 1);
  assert.equal(audit.droplets.length, 1);
  assert.equal(audit.databases[0].engine, "opensearch");
  assert.deepEqual(audit.databaseBackups, [
    {
      engine: "opensearch",
      status: "verified",
      backupCount: 2,
      oldestCreatedAt: "2026-07-30T02:00:00.000Z",
      newestCreatedAt: "2026-07-31T02:00:00.000Z",
      errorCode: null,
      errorStatus: null,
    },
  ]);
  assert.match(formatDigitalOceanAudit(audit), /преглед на ресурсите/u);
  assert.match(formatDigitalOceanAudit(audit), /проверени 23 от 23/u);
  assert.match(
    formatDigitalOceanAudit(audit),
    /без включени автоматични backups/u,
  );
  assert.match(formatDigitalOceanAudit(audit), /Не са направени промени/u);
  assert.match(formatDigitalOceanAudit(audit), /2 налични backup точки/u);
  assert.equal(audit.unavailable.length, 0);
  assert.equal(calls.length, 24);
  assert.ok(calls.every((call) => call.options.method === "GET"));
  assert.doesNotMatch(JSON.stringify(audit), /secret/u);
});

test("database backup inventory reports denied access as unverified without leaking the token", async () => {
  const inventory = await getDigitalOceanDatabaseBackupInventory(
    [{ id: "db-private", engine: "opensearch" }],
    {
      env: { DIGITALOCEAN_API_TOKEN: "secret-backup-token" },
      fetchImpl: async () =>
        Response.json(
          { message: "Bearer secret-backup-token is not allowed" },
          { status: 403 },
        ),
    },
  );

  assert.deepEqual(inventory, [
    {
      engine: "opensearch",
      status: "unverified",
      backupCount: null,
      oldestCreatedAt: null,
      newestCreatedAt: null,
      errorCode: "DIGITALOCEAN_FORBIDDEN",
      errorStatus: 403,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(inventory), /secret-backup-token/u);
});

test("database backup inventory distinguishes a verified empty backup list", async () => {
  const inventory = await getDigitalOceanDatabaseBackupInventory(
    [{ id: "db-empty", engine: "opensearch" }],
    {
      env: { DIGITALOCEAN_API_TOKEN: "test-token" },
      fetchImpl: async () => Response.json({ backups: [] }),
    },
  );

  assert.equal(inventory[0].status, "verified");
  assert.equal(inventory[0].backupCount, 0);
  assert.equal(inventory[0].oldestCreatedAt, null);
  assert.equal(inventory[0].newestCreatedAt, null);
});

test("focused OpenSearch backup audit performs only database and backup reads", async () => {
  const calls = [];
  const audit = await getDigitalOceanOpenSearchBackupAudit({
    env: { DIGITALOCEAN_API_TOKEN: "focused-read-token" },
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (String(url).endsWith("/databases?per_page=200")) {
        return Response.json({
          databases: [
            { id: "db-search", engine: "opensearch" },
            { id: "db-postgres", engine: "pg" },
          ],
        });
      }
      return Response.json({
        backups: [
          { created_at: "2026-07-30T02:00:00Z" },
          { created_at: "2026-07-31T02:00:00Z" },
        ],
      });
    },
  });

  assert.deepEqual(audit.databaseBackups, [
    {
      engine: "opensearch",
      status: "verified",
      backupCount: 2,
      oldestCreatedAt: "2026-07-30T02:00:00.000Z",
      newestCreatedAt: "2026-07-31T02:00:00.000Z",
      errorCode: null,
      errorStatus: null,
    },
  ]);
  assert.deepEqual(
    calls.map(({ url }) => new URL(url).pathname),
    ["/v2/databases", "/v2/databases/db-search/backups"],
  );
  assert.ok(calls.every(({ options }) => options.method === "GET"));
  assert.match(
    formatDigitalOceanOpenSearchBackupAudit(audit),
    /2 налични restore точки/u,
  );
  assert.doesNotMatch(JSON.stringify(audit), /focused-read-token/u);
});

test("Cloudflare bridge reads zone and DNS without writes", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes("/dns_records")) {
      return Response.json({
        success: true,
        result: [
          {
            id: "record-1",
            type: "CNAME",
            name: "synchron.foundation",
            content: "example.ondigitalocean.app",
            proxied: true,
            ttl: 1,
          },
        ],
      });
    }
    return Response.json({
      success: true,
      result: { id: "zone-1", name: "synchron.foundation", status: "active" },
    });
  };
  const status = await getCloudflareZoneStatus({
    env: { CLOUDFLARE_API_TOKEN: "secret", CLOUDFLARE_ZONE_ID: "zone-1" },
    fetchImpl,
  });
  assert.equal(status.status, "active");
  assert.match(formatCloudflareStatus(status), /CNAME/u);
  assert.equal(calls.length, 2);
  assert.ok(
    calls.every(
      (call) => !call.options.method || call.options.method === "GET",
    ),
  );
  assert.doesNotMatch(JSON.stringify(status), /secret/u);
});

test("chat routes infrastructure status requests to the bridges", () => {
  assert.deepEqual(
    detectCapabilityRequests(
      "Провери статуса на DigitalOcean и покажи DNS записите в Cloudflare.",
    ).map(({ capability }) => capability),
    ["infrastructure.digitalocean.read", "infrastructure.cloudflare.read"],
  );
  assert.deepEqual(
    detectCapabilityRequests(
      "Направи пълен одит на целия DigitalOcean акаунт, ресурсите, разходите и сигурността.",
    ).map(({ capability }) => capability),
    ["infrastructure.digitalocean.read"],
  );
});
