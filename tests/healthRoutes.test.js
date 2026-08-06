import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";

import {
  createBridgeDiagnosticsHandler,
  createReadinessHandler,
  createStorageBackupsHandler,
  createStorageDependenciesHandler,
  createStorageReportHandler,
  getBridgeDiagnosticsStatus,
  getReadinessStatus,
  getRuntimeVersion,
  resolveStorageBackupCacheTtlMs,
} from "../src/routes/health.js";

test("liveness version exposes the deployed commit without exposing secrets", () => {
  assert.deepEqual(
    getRuntimeVersion({
      npm_package_version: "1.2.3",
      APP_COMMIT_SHA: "abc123",
    }),
    { version: "1.2.3", commit: "abc123" },
  );
});

test("readiness requires OpenAI and a healthy OpenSearch cluster", async () => {
  let requestOptions;
  const result = await getReadinessStatus({
    env: {
      OPENAI_API_KEY: "secret",
      MCP_ACCESS_TOKEN: "m".repeat(48),
      APP_COMMIT_SHA: "abc123",
    },
    loadOpenSearchClient: () => ({
      cluster: {
        health: async (_params, options) => {
          requestOptions = options;
          return { body: { status: "green" } };
        },
      },
    }),
  });

  assert.deepEqual(requestOptions, { requestTimeout: 2_000, maxRetries: 0 });
  assert.equal(result.status, "ready");
  assert.equal(result.commit, "abc123");
  assert.equal(result.checks.memory.status, "green");
  assert.equal(result.checks.chatAgent.primaryProvider, "openai");
  assert.equal(result.checks.chatAgent.removedProvider, "digitalocean-agent");
  assert.equal(result.checks.bridge.configured, true);
  assert.equal(result.checks.bridge.responding, true);
});

test("readiness accepts OpenAI as the primary chat provider", async () => {
  const result = await getReadinessStatus({
    env: {
      OPENAI_API_KEY: "secret",
      APP_COMMIT_SHA: "openai123",
    },
    loadOpenSearchClient: () => ({
      cluster: {
        health: async () => ({ body: { status: "green" } }),
      },
    }),
  });

  assert.equal(result.status, "ready");
  assert.equal(result.checks.chatAgent.primaryProvider, "openai");
  assert.equal(result.checks.chatAgent.removedProvider, "digitalocean-agent");
});

test("production readiness requires the isolated memory acceptance proof", async () => {
  const baseOptions = {
    env: {
      NODE_ENV: "production",
      OPENAI_API_KEY: "secret",
      MCP_ACCESS_TOKEN: "m".repeat(48),
    },
    loadOpenSearchClient: () => ({
      cluster: {
        health: async () => ({ body: { status: "green" } }),
      },
    }),
  };

  const pending = await getReadinessStatus({
    ...baseOptions,
    loadMemoryVerificationStatus: () => ({
      status: "running",
      attempts: 1,
      startedAt: "2026-07-31T10:00:00.000Z",
      finishedAt: null,
      isolated: true,
      realMemoryUnchanged: null,
      cleanupCompleted: null,
      passedSteps: 0,
      errorCode: null,
    }),
  });
  assert.equal(pending.status, "not-ready");
  assert.equal(pending.checks.memoryAcceptance.required, true);
  assert.equal(pending.checks.memoryAcceptance.ready, false);

  const proven = await getReadinessStatus({
    ...baseOptions,
    loadMemoryVerificationStatus: () => ({
      status: "works",
      attempts: 1,
      startedAt: "2026-07-31T10:00:00.000Z",
      finishedAt: "2026-07-31T10:00:01.000Z",
      isolated: true,
      realMemoryUnchanged: true,
      cleanupCompleted: true,
      passedSteps: 9,
      errorCode: null,
    }),
  });
  assert.equal(proven.status, "ready");
  assert.equal(proven.checks.memoryAcceptance.ready, true);
  assert.equal(proven.checks.memoryAcceptance.realMemoryUnchanged, true);
  assert.equal(proven.checks.memoryAcceptance.cleanupCompleted, true);
});

test("readiness returns 503 when a required dependency is unavailable", async () => {
  const app = express();
  app.get(
    "/health/ready",
    createReadinessHandler({
      env: { OPENAI_API_KEY: "secret" },
      loadOpenSearchClient: () => null,
    }),
  );

  const response = await request(app).get("/health/ready").expect(503);
  assert.equal(response.body.status, "not-ready");
  assert.equal(response.body.checks.memory.ready, false);
});

test("readiness rejects a red OpenSearch cluster", async () => {
  const result = await getReadinessStatus({
    env: { OPENAI_API_KEY: "secret" },
    loadOpenSearchClient: () => ({
      cluster: {
        health: async () => ({ body: { status: "red" } }),
      },
    }),
  });

  assert.equal(result.status, "not-ready");
  assert.equal(result.checks.memory.status, "red");
});

test("dependency health is no-store and returns 503 on a live dependency failure", async () => {
  const app = express();
  app.get(
    "/health/dependencies",
    createStorageDependenciesHandler({
      loadStatus: async () => ({
        status: "unavailable",
        checkedAt: "2026-08-06T10:00:00.000Z",
        checks: {
          opensearch: { status: "healthy" },
          supabase: {
            status: "unavailable",
            errorCode: "SUPABASE_TIMEOUT",
          },
        },
      }),
    }),
  );

  const response = await request(app).get("/health/dependencies").expect(503);
  assert.equal(response.headers["cache-control"], "no-store, max-age=0");
  assert.equal(response.headers.pragma, "no-cache");
  assert.equal(response.body.checks.supabase.errorCode, "SUPABASE_TIMEOUT");
});

test("backup health exposes status without counts, dates or resource ids", async () => {
  const app = express();
  app.get(
    "/health/backups",
    createStorageBackupsHandler({
      loadStatus: async () => ({
        status: "partially-verified",
        checkedAt: "2026-08-06T10:00:00.000Z",
        checks: {
          opensearch: {
            status: "verified",
            fresh: true,
            restorePointCount: 3,
            oldestCreatedAt: "2026-08-03T10:00:00.000Z",
            newestCreatedAt: "2026-08-06T10:00:00.000Z",
          },
          supabase: {
            status: "unverified",
            errorCode: "SUPABASE_BACKUP_STATUS_NOT_VISIBLE_TO_RUNTIME",
          },
        },
      }),
    }),
  );

  const response = await request(app).get("/health/backups").expect(503);
  assert.equal(response.body.status, "partially-verified");
  const serialized = JSON.stringify(response.body);
  assert.equal(response.body.checks.opensearch.status, "verified");
  assert.equal(response.body.checks.opensearch.fresh, true);
  assert.equal(response.body.checks.opensearch.provesRestore, false);
  assert.equal(response.body.checks.supabase.status, "unverified");
  assert.doesNotMatch(
    serialized,
    /restorePointCount|oldestCreatedAt|newestCreatedAt|databaseId/u,
  );
});

test("storage report keeps partial evidence readable without changing health semantics", async () => {
  const app = express();
  app.get(
    "/health/storage-report",
    createStorageReportHandler({
      loadDependencies: async () => ({
        status: "healthy",
        checkedAt: "2026-08-06T10:00:00.000Z",
        checks: {
          opensearch: { status: "healthy", memoryIndexReadable: true },
          supabase: { status: "healthy" },
        },
      }),
      loadBackups: async () => ({
        status: "partially-verified",
        checkedAt: "2026-08-06T10:00:00.000Z",
        checks: {
          opensearch: {
            status: "verified",
            fresh: true,
            restorePointCount: 3,
            newestCreatedAt: "2026-08-06T09:00:00.000Z",
          },
          supabase: {
            status: "unverified",
            errorCode: "SUPABASE_BACKUP_STATUS_NOT_VISIBLE_TO_RUNTIME",
          },
        },
      }),
      now: () => new Date("2026-08-06T10:00:01.000Z"),
    }),
  );

  const response = await request(app).get("/health/storage-report").expect(200);
  assert.equal(response.headers["cache-control"], "no-store, max-age=0");
  assert.equal(response.body.status, "reported");
  assert.equal(response.body.dependencies.status, "healthy");
  assert.equal(response.body.backups.status, "partially-verified");
  assert.equal(response.body.backups.checks.opensearch.provesRestore, false);
  assert.doesNotMatch(
    JSON.stringify(response.body.backups),
    /restorePointCount|newestCreatedAt|databaseId/u,
  );
});

test("storage report converts unexpected loader failures into safe fixed codes", async () => {
  const app = express();
  app.get(
    "/health/storage-report",
    createStorageReportHandler({
      loadDependencies: async () => {
        throw new Error("sensitive dependency failure");
      },
      loadBackups: async () => {
        throw new Error("sensitive backup failure");
      },
    }),
  );

  const response = await request(app).get("/health/storage-report").expect(200);
  const serialized = JSON.stringify(response.body);
  assert.equal(response.body.dependencies.status, "unavailable");
  assert.equal(response.body.backups.status, "unavailable");
  assert.match(serialized, /STORAGE_DEPENDENCY_REPORT_FAILED/u);
  assert.match(serialized, /STORAGE_BACKUP_REPORT_FAILED/u);
  assert.doesNotMatch(serialized, /sensitive/u);
});

test("verified backup cache cannot outlive the remaining freshness window", () => {
  const now = () => Date.parse("2026-08-06T10:00:00.000Z");
  const nearlyStale = {
    checks: {
      opensearch: {
        status: "verified",
        fresh: true,
        newestCreatedAt: "2026-08-04T10:01:00.000Z",
      },
    },
  };

  assert.equal(
    resolveStorageBackupCacheTtlMs(nearlyStale, { now, maxAgeHours: 48 }),
    60_000,
  );
  assert.equal(
    resolveStorageBackupCacheTtlMs(
      {
        checks: {
          opensearch: {
            status: "verified",
            fresh: true,
            newestCreatedAt: "2026-08-06T09:00:00.000Z",
          },
        },
      },
      { now, maxAgeHours: 48 },
    ),
    6 * 60 * 60_000,
  );
  assert.equal(
    resolveStorageBackupCacheTtlMs(
      { checks: { opensearch: { status: "unverified" } } },
      { now, maxAgeHours: 48 },
    ),
    15_000,
  );
});

test("bridge diagnostics distinguish configuration, response and ChatGPT OAuth readiness", async () => {
  const result = await getBridgeDiagnosticsStatus({
    env: {
      MCP_ACCESS_TOKEN: "m".repeat(48),
      APP_COMMIT_SHA: "bridge123",
    },
    handleMcpRequest: async () => ({
      result: { serverInfo: { name: "synchron-x-memory" } },
    }),
  });

  assert.equal(result.status, "operational");
  assert.equal(result.commit, "bridge123");
  assert.equal(result.bridge.configured, true);
  assert.equal(result.bridge.reachable, true);
  assert.equal(result.bridge.responding, true);
  assert.equal(result.bridge.readOnly, false);
  assert.equal(result.bridge.tools, 50);
  assert.equal(result.bridge.readOnlyTools, 27);
  assert.equal(result.bridge.destructiveTools, 8);
  assert.equal(result.bridge.authentication.chatgptOAuthReady, true);
  assert.equal(
    result.bridge.authentication.mode,
    "oauth2-with-legacy-static-bearer",
  );
  assert.equal(
    result.bridge.authentication.discovery,
    "/.well-known/oauth-protected-resource",
  );
});

test("bridge diagnostics fail honestly when the token is missing", async () => {
  const app = express();
  app.get(
    "/health/bridge",
    createBridgeDiagnosticsHandler({
      env: {},
      handleMcpRequest: async () => ({
        result: { serverInfo: { name: "synchron-x-memory" } },
      }),
    }),
  );

  const response = await request(app).get("/health/bridge").expect(503);
  assert.equal(response.body.status, "incomplete");
  assert.equal(response.body.bridge.configured, false);
  assert.equal(response.body.bridge.responding, true);
  assert.equal(response.body.bridge.authentication.chatgptOAuthReady, false);
});

test("bridge diagnostics stop a blocked self-check within the configured timeout", async () => {
  const startedAt = Date.now();
  const result = await getBridgeDiagnosticsStatus({
    env: { MCP_ACCESS_TOKEN: "m".repeat(48) },
    handleMcpRequest: () => new Promise(() => {}),
    timeoutMs: 10,
  });

  assert.equal(result.status, "incomplete");
  assert.equal(result.bridge.configured, true);
  assert.equal(result.bridge.responding, false);
  assert.ok(Date.now() - startedAt < 1_000);
});
