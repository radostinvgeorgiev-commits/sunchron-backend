import assert from "node:assert/strict";
import test from "node:test";

import {
  formatGoogleCloudRuntimeStatus,
  getGoogleCloudRuntimeStatus,
} from "../src/services/googleCloudService.js";

test("Google Cloud runtime reports Cloud Run and Firestore without secrets", () => {
  const status = getGoogleCloudRuntimeStatus({
    env: {
      GOOGLE_CLOUD_PROJECT: "project-1",
      K_SERVICE: "ai-core",
      K_REVISION: "ai-core-00042",
      K_CONFIGURATION: "ai-core",
      GOOGLE_CLOUD_REGION: "europe-west1",
      MEMORY_BACKEND: "firestore",
      PERSISTENCE_BACKEND: "firestore",
      FIRESTORE_DATABASE_ID: "(default)",
      AUTH_BACKEND: "identity-platform",
      OPENAI_API_KEY: "must-not-appear",
    },
  });

  assert.equal(status.provider, "google-cloud");
  assert.equal(status.status, "running");
  assert.equal(status.canonicalOrigin, "https://cloudaicore.com");
  const output = formatGoogleCloudRuntimeStatus(status);
  assert.match(output, /Cloud Run: потвърден/u);
  assert.doesNotMatch(output, /must-not-appear/u);
});
