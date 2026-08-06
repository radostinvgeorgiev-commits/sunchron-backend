import assert from "node:assert/strict";
import test from "node:test";

import {
  createSingleFlightCache,
  inspectStorageBackups,
  inspectStorageDependencies,
} from "../src/services/storageHealthService.js";
import { checkSupabaseStatus } from "../src/services/supabaseService.js";
import { TESTER_AUTH_BOOTSTRAP } from "../src/config/testerAuthBootstrap.js";

test("storage dependency health verifies OpenSearch and Supabase without secrets", async () => {
  const report = await inspectStorageDependencies({
    loadOpenSearchClient: () => ({
      cluster: {
        health: async (_params, options) => {
          assert.deepEqual(options, { requestTimeout: 5_000, maxRetries: 0 });
          return { body: { status: "green" } };
        },
      },
      search: async (request, options) => {
        assert.deepEqual(options, { requestTimeout: 5_000, maxRetries: 0 });
        assert.equal(request.index, "synchron-profile-memory-v1");
        assert.equal(request.body.size, 0);
        assert.equal(request.body.track_total_hits, false);
        assert.deepEqual(request.body._source, false);
        assert.equal(
          request.body.query.term.ownerId,
          "__synchron_health_monitor_no_user__",
        );
        return { body: { hits: { hits: [] } } };
      },
    }),
    checkSupabase: async () => ({ status: "healthy", responseTimeMs: 18 }),
    now: () => new Date("2026-08-06T10:00:00.000Z"),
  });

  assert.equal(report.status, "healthy");
  assert.equal(report.checks.opensearch.clusterStatus, "green");
  assert.equal(report.checks.opensearch.memoryIndexReadable, true);
  assert.equal(report.checks.opensearch.tlsVerificationRequired, true);
  assert.equal(report.checks.supabase.responseTimeMs, 18);
  assert.equal(JSON.stringify(report).includes("password"), false);
  assert.equal(JSON.stringify(report).includes("publishable"), false);
});

test("storage health forwards its timeout to the real Supabase abort signal", async () => {
  let aborted = false;
  const report = await inspectStorageDependencies({
    timeoutMs: 10,
    loadOpenSearchClient: () => ({
      cluster: { health: async () => ({ body: { status: "green" } }) },
      search: async () => ({ body: { hits: { hits: [] } } }),
    }),
    checkSupabase: (options) =>
      checkSupabaseStatus({
        ...options,
        projectUrl: "https://example.supabase.co",
        publishableKey: "sb_publishable_public_test_key_1234567890",
        fetchImpl: async (_url, { signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                aborted = true;
                reject(
                  Object.assign(new Error("aborted"), { name: "AbortError" }),
                );
              },
              { once: true },
            );
          }),
      }),
  });

  assert.equal(aborted, true);
  assert.equal(report.status, "unavailable");
  assert.equal(report.checks.supabase.errorCode, "SUPABASE_TIMEOUT");
});

test("storage health uses the public bootstrap for App Platform placeholders", async () => {
  const report = await inspectStorageDependencies({
    loadOpenSearchClient: () => ({
      cluster: { health: async () => ({ body: { status: "green" } }) },
      search: async () => ({ body: { hits: { hits: [] } } }),
    }),
    checkSupabase: (options) =>
      checkSupabaseStatus({
        ...options,
        env: {
          SUPABASE_URL: "EV[1:encrypted-placeholder]",
          SUPABASE_PUBLISHABLE_KEY: "EV[1:encrypted-placeholder]",
        },
        fetchImpl: async (url, request) => {
          assert.equal(
            url,
            `${TESTER_AUTH_BOOTSTRAP.projectUrl}/auth/v1/settings`,
          );
          assert.equal(
            request.headers.apikey,
            TESTER_AUTH_BOOTSTRAP.publishableKey,
          );
          return new Response("{}", { status: 200 });
        },
      }),
  });

  assert.equal(report.status, "healthy");
  assert.equal(report.checks.supabase.status, "healthy");
  assert.equal(
    report.checks.supabase.connectionSource,
    "public-bootstrap",
  );
  assert.doesNotMatch(
    JSON.stringify(report),
    new RegExp(TESTER_AUTH_BOOTSTRAP.publishableKey, "u"),
  );
  assert.doesNotMatch(
    JSON.stringify(report),
    new RegExp(new URL(TESTER_AUTH_BOOTSTRAP.projectUrl).hostname, "u"),
  );
});

test("backup timeout aborts the underlying DigitalOcean request", async () => {
  let aborted = false;
  const report = await inspectStorageBackups({
    timeoutMs: 10,
    loadOpenSearchBackupAudit: ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          },
          { once: true },
        );
      }),
  });

  assert.equal(aborted, true);
  assert.equal(report.status, "unavailable");
  assert.equal(report.checks.opensearch.errorCode, "OPENSEARCH_BACKUP_TIMEOUT");
});

test("storage dependency health fails closed when Supabase is unavailable", async () => {
  const error = new Error("sensitive upstream response");
  error.code = "SUPABASE_TIMEOUT";
  const report = await inspectStorageDependencies({
    loadOpenSearchClient: () => ({
      cluster: { health: async () => ({ body: { status: "yellow" } }) },
      search: async () => ({ body: { hits: { hits: [] } } }),
    }),
    checkSupabase: async () => {
      throw error;
    },
  });

  assert.equal(report.status, "unavailable");
  assert.equal(report.checks.opensearch.status, "healthy");
  assert.deepEqual(report.checks.supabase, {
    status: "unavailable",
    errorCode: "SUPABASE_TIMEOUT",
  });
  assert.doesNotMatch(JSON.stringify(report), /sensitive upstream response/u);
});

test("backup health exposes only aggregate OpenSearch restore-point evidence", async () => {
  const report = await inspectStorageBackups({
    loadOpenSearchBackupAudit: async () => ({
      checkedAt: "2026-08-06T09:00:00.000Z",
      databaseBackups: [
        {
          engine: "opensearch",
          status: "verified",
          backupCount: 3,
          oldestCreatedAt: "2026-08-03T09:00:00.000Z",
          newestCreatedAt: "2026-08-06T09:00:00.000Z",
        },
      ],
    }),
    now: () => new Date("2026-08-06T10:00:00.000Z"),
  });

  assert.equal(report.status, "partially-verified");
  assert.equal(report.checks.opensearch.status, "verified");
  assert.equal(report.checks.opensearch.fresh, true);
  assert.equal(report.checks.opensearch.restorePointCount, 3);
  assert.equal(report.checks.opensearch.restoreTested, false);
  assert.equal(report.checks.supabase.status, "unverified");
  assert.equal(
    report.checks.supabase.errorCode,
    "SUPABASE_BACKUP_STATUS_NOT_VISIBLE_TO_RUNTIME",
  );
  assert.equal("id" in report.checks.opensearch, false);
});

test("backup health rejects a stale OpenSearch restore point", async () => {
  const report = await inspectStorageBackups({
    loadOpenSearchBackupAudit: async () => ({
      checkedAt: "2026-08-06T09:00:00.000Z",
      databaseBackups: [
        {
          engine: "opensearch",
          status: "verified",
          backupCount: 1,
          oldestCreatedAt: "2020-01-01T00:00:00.000Z",
          newestCreatedAt: "2020-01-01T00:00:00.000Z",
        },
      ],
    }),
    now: () => new Date("2026-08-06T10:00:00.000Z"),
  });

  assert.equal(report.status, "unavailable");
  assert.equal(report.checks.opensearch.status, "stale");
  assert.equal(report.checks.opensearch.fresh, false);
  assert.equal(
    report.checks.opensearch.errorCode,
    "OPENSEARCH_RESTORE_POINTS_STALE",
  );
});

test("backup health fails when OpenSearch has no verified restore point", async () => {
  const report = await inspectStorageBackups({
    loadOpenSearchBackupAudit: async () => ({
      checkedAt: "2026-08-06T09:00:00.000Z",
      databaseBackups: [
        {
          engine: "opensearch",
          status: "verified",
          backupCount: 0,
        },
      ],
    }),
  });

  assert.equal(report.status, "unavailable");
  assert.equal(report.checks.opensearch.status, "empty");
  assert.equal(
    report.checks.opensearch.errorCode,
    "OPENSEARCH_RESTORE_POINTS_EMPTY",
  );
});

test("single-flight cache coalesces checks and expires them", async () => {
  let calls = 0;
  let clock = 1_000;
  let release;
  const blocker = new Promise((resolve) => {
    release = resolve;
  });
  const load = createSingleFlightCache(
    async () => {
      calls += 1;
      if (calls === 1) await blocker;
      return { calls };
    },
    { ttlMs: 30_000, now: () => clock },
  );

  const first = load();
  const concurrent = load();
  release();
  assert.deepEqual(await first, { calls: 1 });
  assert.deepEqual(await concurrent, { calls: 1 });
  assert.deepEqual(await load(), { calls: 1 });

  clock += 30_001;
  assert.deepEqual(await load(), { calls: 2 });
});

test("single-flight cache supports shorter failure and longer success windows", async () => {
  let clock = 0;
  let calls = 0;
  const load = createSingleFlightCache(
    async () => ({ status: ++calls === 1 ? "unavailable" : "healthy" }),
    {
      ttlMs: (value) => (value.status === "healthy" ? 60_000 : 5_000),
      now: () => clock,
    },
  );

  assert.equal((await load()).status, "unavailable");
  clock = 4_999;
  assert.equal((await load()).status, "unavailable");
  clock = 5_001;
  assert.equal((await load()).status, "healthy");
  clock = 65_000;
  assert.equal((await load()).status, "healthy");
  clock = 65_002;
  assert.equal((await load()).status, "healthy");
  assert.equal(calls, 3);
});
