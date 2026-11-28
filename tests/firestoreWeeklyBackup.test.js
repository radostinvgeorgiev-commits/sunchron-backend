import test from "node:test";
import assert from "node:assert/strict";

import {
  confirmGoogleCloudAction,
  prepareGoogleCloudAction,
} from "../src/services/googleCloudActionService.js";
import { inspectStorageBackups } from "../src/services/storageHealthService.js";

const env = { GOOGLE_CLOUD_PROJECT: "handy-boulevard-479120-q9" };
const SCHEDULES =
  "https://firestore.googleapis.com/v1/projects/handy-boulevard-479120-q9/databases/(default)/backupSchedules";

function cloudFetch(responses, calls) {
  return async (url, options = {}) => {
    if (String(url).startsWith("http://metadata.google.internal/")) {
      return { ok: true, json: async () => ({ access_token: "token" }) };
    }
    calls.push({ url: String(url), method: options.method || "GET", body: options.body });
    const body = responses.shift();
    return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
  };
}

async function prepareBackup() {
  let stored;
  const prepared = await prepareGoogleCloudAction(
    { ownerId: "owner", sessionId: "s", operation: "enable_firestore_weekly_backup", input: {}, env },
    { createConfirmation: async (c) => ((stored = c), { id: "c1", expiresAt: 1 }) },
  );
  return { stored, prepared };
}

async function confirm(stored, fetchImpl) {
  return confirmGoogleCloudAction(
    { ownerId: "owner", sessionId: "s", confirmationId: "c1" },
    {
      validateConfirmation: async () => stored,
      consumeConfirmation: async () => {},
      executeWrite: async ({ execute }) => execute(),
      adapters: { fetchImpl },
    },
  );
}

test("weekly backup is prepared for the live database only, without input", async () => {
  const { stored, prepared } = await prepareBackup();
  assert.equal(stored.action, "infrastructure.write:enable_firestore_weekly_backup");
  assert.deepEqual(prepared.resource, { projectId: "handy-boulevard-479120-q9", databaseId: "(default)" });
  assert.deepEqual(prepared.params, { day: "SUNDAY", retention: "8467200s" });
});

test("confirming creates one weekly Sunday schedule", async () => {
  const { stored } = await prepareBackup();
  const calls = [];
  const result = await confirm(
    stored,
    cloudFetch([{}, { name: `${SCHEDULES}/abc` }], calls),
  );
  assert.deepEqual(
    calls.map(({ url, method }) => ({ url, method })),
    [
      { url: SCHEDULES, method: "GET" },
      { url: SCHEDULES, method: "POST" },
    ],
  );
  assert.deepEqual(JSON.parse(calls[1].body), {
    retention: "8467200s",
    weeklyRecurrence: { day: "SUNDAY" },
  });
  assert.equal(result.created, true);
});

test("an existing weekly schedule is kept as it is", async () => {
  const { stored } = await prepareBackup();
  const calls = [];
  const result = await confirm(
    stored,
    cloudFetch(
      [{ backupSchedules: [{ name: "s1", retention: "604800s", weeklyRecurrence: { day: "MONDAY" } }] }],
      calls,
    ),
  );
  assert.equal(calls.length, 1);
  assert.equal(result.created, false);
  assert.equal(result.day, "MONDAY");
});

const runtimeEnv = { ...env, K_SERVICE: "synchron-backend-google" };

test("backup status reads the schedule and the latest copy", async () => {
  const calls = [];
  const report = await inspectStorageBackups({
    now: () => new Date("2026-11-30T12:00:00.000Z"),
    env: runtimeEnv,
    fetchImpl: cloudFetch(
      [
        { backupSchedules: [{ name: "s1", retention: "8467200s", weeklyRecurrence: { day: "SUNDAY" } }] },
        {
          backups: [
            { state: "READY", database: "projects/handy-boulevard-479120-q9/databases/(default)", snapshotTime: "2026-11-29T03:00:00Z" },
            { state: "READY", database: "projects/other/databases/(default)", snapshotTime: "2026-11-30T03:00:00Z" },
            { state: "CREATING", database: "projects/handy-boulevard-479120-q9/databases/(default)", snapshotTime: "2026-11-30T03:00:00Z" },
          ],
        },
      ],
      calls,
    ),
  });
  assert.ok(calls.every((call) => call.method === "GET"));
  assert.equal(report.status, "verified");
  assert.equal(report.checks.firestore.backupCount, 1);
  assert.equal(report.checks.firestore.latestBackupAt, "2026-11-29T03:00:00Z");
});

test("backup status says honestly when nothing is scheduled", async () => {
  const report = await inspectStorageBackups({
    now: () => new Date("2026-11-30T12:00:00.000Z"),
    env: runtimeEnv,
    fetchImpl: cloudFetch([{}, {}], []),
  });
  assert.equal(report.status, "unverified");
  assert.equal(report.checks.firestore.status, "missing");
  assert.equal(report.checks.firestore.errorCode, "FIRESTORE_WEEKLY_BACKUP_NOT_SCHEDULED");
});

test("a schedule without a fresh copy is only scheduled", async () => {
  const report = await inspectStorageBackups({
    now: () => new Date("2026-11-30T12:00:00.000Z"),
    env: runtimeEnv,
    fetchImpl: cloudFetch(
      [{ backupSchedules: [{ name: "s1", weeklyRecurrence: { day: "SUNDAY" } }] }, { backups: [] }],
      [],
    ),
  });
  assert.equal(report.status, "scheduled");
  assert.equal(report.checks.firestore.latestBackupAt, null);
});
