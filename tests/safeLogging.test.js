import assert from "node:assert/strict";
import test from "node:test";

import { logSafeError, safeErrorMetadata } from "../src/utils/safeLogging.js";

const SENTINEL = "Bearer private-token personal@example.com private-prompt";

function sensitiveError() {
  const error = new Error(SENTINEL, {
    cause: new Error(`cause-${SENTINEL}`),
  });
  error.name = "OAuthSessionError";
  error.code = "SESSION_PERSISTENCE_FAILED";
  error.status = 503;
  error.stack = `stack-${SENTINEL}`;
  error.request = { headers: { authorization: SENTINEL } };
  error.response = { status: 502, data: SENTINEL };
  return error;
}

test("safe error metadata excludes messages, stacks, causes, and provider data", () => {
  const metadata = safeErrorMetadata(sensitiveError());
  assert.deepEqual(metadata, {
    name: "OAuthSessionError",
    code: "SESSION_PERSISTENCE_FAILED",
    status: 503,
  });
  assert.doesNotMatch(JSON.stringify(metadata), new RegExp(SENTINEL, "u"));
});

test("unsafe error codes cannot inject arbitrary text into logs", () => {
  const error = sensitiveError();
  error.code = "PrivateTokenAbCd123";
  assert.deepEqual(safeErrorMetadata(error), {
    name: "OAuthSessionError",
    status: 503,
  });
});

test("safe logger emits only the fixed context and safe metadata", () => {
  const originalConsoleError = console.error;
  const calls = [];
  console.error = (...values) => calls.push(values);
  try {
    logSafeError("[OAuth test]", sensitiveError());
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "[OAuth test]");
  assert.deepEqual(calls[0][1], {
    name: "OAuthSessionError",
    code: "SESSION_PERSISTENCE_FAILED",
    status: 503,
  });
  assert.doesNotMatch(JSON.stringify(calls), new RegExp(SENTINEL, "u"));
});
