import assert from "node:assert/strict";
import test from "node:test";

import {
  getFirestoreConfigurationStatus,
  getFirestoreClient,
  resetFirestoreClientForTests,
  resolveFirestoreConfig,
} from "../src/config/firestore.js";

const enabledEnvironment = {
  FIRESTORE_ENABLED: "true",
  GCP_PROJECT_ID: "synchron-shadow-test",
  FIRESTORE_DATABASE_ID: "synchron-shadow-v1",
  FIRESTORE_LOCATION: "europe-west1",
  FIRESTORE_COLLECTION_PREFIX: "synchron-shadow-",
};

test("Firestore stays disabled and does not create a client by default", () => {
  const config = resolveFirestoreConfig({});

  assert.equal(config.enabled, false);
  assert.equal(config.mode, "disabled");
  assert.equal(getFirestoreClient({}), null);
  assert.equal(getFirestoreConfigurationStatus({}).status, "disabled");
});

test("Firestore requires an explicit complete shadow configuration", () => {
  const config = resolveFirestoreConfig(enabledEnvironment);

  assert.deepEqual(
    {
      enabled: config.enabled,
      mode: config.mode,
      projectId: config.projectId,
      databaseId: config.databaseId,
      location: config.location,
      collectionPrefix: config.collectionPrefix,
    },
    {
      enabled: true,
      mode: "shadow",
      projectId: "synchron-shadow-test",
      databaseId: "synchron-shadow-v1",
      location: "europe-west1",
      collectionPrefix: "synchron-shadow-",
    },
  );
  assert.equal(
    getFirestoreConfigurationStatus(enabledEnvironment).status,
    "configured",
  );
});

test("explicit emulator configuration is applied to the Firestore client", async () => {
  const client = getFirestoreClient({
    ...enabledEnvironment,
    FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
    NODE_ENV: "test",
  });

  try {
    assert.equal(client._settings.servicePath, "127.0.0.1");
    assert.equal(client._settings.port, 8080);
    assert.equal(client._settings.ssl, false);
  } finally {
    await client.terminate();
    resetFirestoreClientForTests();
  }
});

test("invalid Firestore flag and missing fields fail closed", () => {
  assert.throws(
    () => resolveFirestoreConfig({ FIRESTORE_ENABLED: "yes" }),
    (error) => error.code === "FIRESTORE_CONFIGURATION_INVALID",
  );

  assert.throws(
    () => resolveFirestoreConfig({ FIRESTORE_ENABLED: "true" }),
    (error) =>
      error.code === "FIRESTORE_CONFIGURATION_INVALID" &&
      error.missing.includes("GCP_PROJECT_ID") &&
      error.missing.includes("FIRESTORE_DATABASE_ID"),
  );
});

test("production cannot use a Firestore emulator", () => {
  const status = getFirestoreConfigurationStatus({
    ...enabledEnvironment,
    NODE_ENV: "production",
    FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
  });

  assert.equal(status.status, "misconfigured");
  assert.equal(status.enabled, true);
  assert.equal(status.errorCode, "FIRESTORE_CONFIGURATION_INVALID");
  assert.deepEqual(status.invalid, ["FIRESTORE_EMULATOR_HOST_PRODUCTION"]);
});

test("Firestore configuration status never returns secret-like values", () => {
  const status = getFirestoreConfigurationStatus({
    ...enabledEnvironment,
    FIRESTORE_ENABLED: "unexpected-secret-value",
    GOOGLE_APPLICATION_CREDENTIALS: "private-key.json",
  });

  const serialized = JSON.stringify(status);
  assert.doesNotMatch(serialized, /unexpected-secret-value|private-key\.json/u);
  assert.equal(status.status, "misconfigured");
});
