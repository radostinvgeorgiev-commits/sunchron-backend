import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  logSafeError,
  safeErrorCode,
  safeErrorMetadata,
} from "../src/utils/safeLogging.js";

const SENTINEL = "Bearer private-token personal@example.com private-prompt";
const SAFE_LOGGING_CALLERS = [
  "../src/config/opensearch.js",
  "../src/routes/calendarRouter.js",
  "../src/routes/chat.js",
  "../src/routes/confirmedActionsRouter.js",
  "../src/routes/githubRouter.js",
  "../src/routes/memoryRouter.js",
  "../src/routes/permissionsRouter.js",
  "../src/routes/projects.js",
  "../src/routes/testerAuthAdminRouter.js",
  "../src/routes/webSearchRouter.js",
  "../src/services/confirmationService.js",
  "../src/services/taskExecutionService.js",
];

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

test("safe error metadata keeps a bounded upstream status for diagnostics", () => {
  const error = sensitiveError();
  error.upstreamErrorStatus = "FAILED_PRECONDITION";
  assert.deepEqual(safeErrorMetadata(error), {
    name: "OAuthSessionError",
    code: "SESSION_PERSISTENCE_FAILED",
    upstreamErrorStatus: "FAILED_PRECONDITION",
    status: 503,
  });

  error.upstreamErrorStatus = SENTINEL;
  assert.doesNotMatch(
    JSON.stringify(safeErrorMetadata(error)),
    /private-token/u,
  );
});

test("safe error codes use only validated codes or fixed fallbacks", () => {
  assert.equal(safeErrorCode(sensitiveError()), "SESSION_PERSISTENCE_FAILED");

  const error = sensitiveError();
  error.code = SENTINEL;
  assert.equal(
    safeErrorCode(error, "PROVIDER_REQUEST_FAILED"),
    "PROVIDER_REQUEST_FAILED",
  );
  assert.equal(safeErrorCode(error, SENTINEL), "UNCLASSIFIED_ERROR");
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

test("server failure paths keep direct errors out of logs and audit details", () => {
  for (const relativePath of SAFE_LOGGING_CALLERS) {
    const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
    assert.doesNotMatch(source, /console\.error\s*\(/u, relativePath);
    assert.doesNotMatch(
      source,
      /details\s*:\s*error(?:\?\.|\.)/u,
      relativePath,
    );
    assert.doesNotMatch(
      source,
      /details\s*:[^\n]*error\.message/u,
      relativePath,
    );
  }
});
