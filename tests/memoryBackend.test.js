import assert from "node:assert/strict";
import test from "node:test";

import {
  isMemoryBackendConfigured,
  isPersistenceBackendConfigured,
  resolveMemoryBackend,
  resolvePersistenceBackend,
} from "../src/config/memoryBackend.js";

test("Google Cloud runtime selects Firestore; development without a project stays local", () => {
  assert.equal(resolveMemoryBackend({}), "local");
  assert.equal(resolvePersistenceBackend({}), "local");
  assert.equal(isMemoryBackendConfigured({}), false);
  assert.equal(
    resolveMemoryBackend({ GOOGLE_CLOUD_PROJECT: "handy-boulevard-479120-q9" }),
    "firestore",
  );
  assert.equal(resolveMemoryBackend({ NODE_ENV: "production" }), "firestore");
  assert.equal(
    resolvePersistenceBackend({ NODE_ENV: "production" }),
    "firestore",
  );
  // OpenSearch is gone, and production never falls back to the local store.
  assert.equal(
    resolveMemoryBackend({
      NODE_ENV: "production",
      MEMORY_BACKEND: "opensearch",
    }),
    null,
  );
  assert.equal(
    resolveMemoryBackend({ NODE_ENV: "production", MEMORY_BACKEND: "local" }),
    null,
  );
  assert.equal(
    resolvePersistenceBackend({
      NODE_ENV: "production",
      PERSISTENCE_BACKEND: "local",
    }),
    null,
  );
});

test("Firestore requires an explicit project and valid database selection", () => {
  assert.equal(
    isMemoryBackendConfigured({ MEMORY_BACKEND: "firestore" }),
    false,
  );
  assert.equal(
    isMemoryBackendConfigured({
      MEMORY_BACKEND: "firestore",
      GOOGLE_CLOUD_PROJECT: "handy-boulevard-479120-q9",
      FIRESTORE_DATABASE_ID: "(default)",
    }),
    true,
  );
  assert.equal(
    isMemoryBackendConfigured({
      MEMORY_BACKEND: "firestore",
      GOOGLE_CLOUD_PROJECT: "handy-boulevard-479120-q9",
      FIRESTORE_DATABASE_ID: "invalid/database",
    }),
    false,
  );
});

test("persistence can follow memory or fail closed on an invalid override", () => {
  const firestore = {
    MEMORY_BACKEND: "firestore",
    GOOGLE_CLOUD_PROJECT: "handy-boulevard-479120-q9",
  };
  assert.equal(resolvePersistenceBackend(firestore), "firestore");
  assert.equal(isPersistenceBackendConfigured(firestore), true);
  assert.equal(
    resolvePersistenceBackend({
      ...firestore,
      PERSISTENCE_BACKEND: "unknown",
    }),
    null,
  );
  assert.equal(
    isPersistenceBackendConfigured({
      ...firestore,
      PERSISTENCE_BACKEND: "unknown",
    }),
    false,
  );
});
