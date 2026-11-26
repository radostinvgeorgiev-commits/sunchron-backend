import test from "node:test";
import assert from "node:assert/strict";

import {
  ENABLEABLE_GOOGLE_APIS,
  confirmGoogleCloudAction,
  prepareGoogleCloudAction,
} from "../src/services/googleCloudActionService.js";

const env = { GOOGLE_CLOUD_PROJECT: "handy-boulevard-479120-q9" };

test("only the listed Google APIs can be prepared", async () => {
  assert.ok(ENABLEABLE_GOOGLE_APIS.includes("youtube.googleapis.com"));
  let stored;
  const prepared = await prepareGoogleCloudAction(
    { ownerId: "owner", sessionId: "s", operation: "enable_google_api", input: { api: "meet.googleapis.com" }, env },
    { createConfirmation: async (c) => ((stored = c), { id: "c1", expiresAt: 1 }) },
  );
  assert.equal(stored.action, "infrastructure.write:enable_google_api");
  assert.equal(prepared.resource.api, "meet.googleapis.com");
  for (const api of ["iam.googleapis.com", "compute.googleapis.com", "", undefined]) {
    await assert.rejects(
      prepareGoogleCloudAction(
        { ownerId: "owner", sessionId: "s", operation: "enable_google_api", input: { api }, env },
        { createConfirmation: async () => ({ id: "x" }) },
      ),
    );
  }
});

test("confirming calls Service Usage enable for exactly that API", async () => {
  let stored;
  await prepareGoogleCloudAction(
    { ownerId: "owner", sessionId: "s", operation: "enable_google_api", input: { api: "photospicker.googleapis.com" }, env },
    { createConfirmation: async (c) => ((stored = c), { id: "c1", expiresAt: 1 }) },
  );
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    if (String(url).startsWith("http://metadata.google.internal/")) {
      return { ok: true, json: async () => ({ access_token: "token" }) };
    }
    calls.push({ url: String(url), method: options.method });
    return { ok: true, status: 200, text: async () => '{"name":"operations/x"}' };
  };
  const result = await confirmGoogleCloudAction(
    { ownerId: "owner", sessionId: "s", confirmationId: "c1" },
    {
      validateConfirmation: async () => stored,
      consumeConfirmation: async () => {},
      executeWrite: async ({ execute }) => execute(),
      adapters: { fetchImpl },
    },
  );
  assert.deepEqual(calls, [
    {
      url: "https://serviceusage.googleapis.com/v1/projects/handy-boulevard-479120-q9/services/photospicker.googleapis.com:enable",
      method: "POST",
    },
  ]);
  assert.equal(result.enabled, true);
  assert.equal(result.api, "photospicker.googleapis.com");
});
