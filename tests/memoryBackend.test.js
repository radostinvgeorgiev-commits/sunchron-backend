import assert from "node:assert/strict";
import test from "node:test";

import {
  isMemoryBackendConfigured,
  isPersistenceBackendConfigured,
  resolveMemoryBackend,
  resolvePersistenceBackend,
} from "../src/config/memoryBackend.js";

test("legacy runtime defaults to OpenSearch until GCP is selected explicitly", () => {
  assert.equal(resolveMemoryBackend({}), "opensearch");
  assert.equal(resolvePersistenceBackend({}), "opensearch");
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
