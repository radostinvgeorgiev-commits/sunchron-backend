import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("Cloud Run container foundation is production-safe and commit-aware", async () => {
  const [dockerfile, dockerignore] = await Promise.all([
    read("../Dockerfile"),
    read("../.dockerignore"),
  ]);

  assert.match(dockerfile, /^FROM node:22-bookworm-slim$/mu);
  assert.match(dockerfile, /ARG APP_COMMIT_SHA=unknown/u);
  assert.match(dockerfile, /PORT=8080/u);
  assert.match(dockerfile, /npm ci --omit=dev/u);
  assert.match(dockerfile, /USER node/u);
  assert.match(dockerfile, /CMD \["npm", "start"\]/u);
  assert.match(dockerignore, /^\.env$/mu);
  assert.match(dockerignore, /^\.env\.\*$/mu);
  assert.match(dockerignore, /^node_modules$/mu);
  assert.match(dockerignore, /^runtime-build-info\.json$/mu);
  assert.match(dockerignore, /^firestore\.indexes\.json$/mu);
  assert.match(dockerignore, /^\.git$/mu);
});

test("Cloud Run template uses liveness without dependency-heavy readiness", async () => {
  const template = await read("../deploy/cloud-run/service.yaml.template");

  assert.match(template, /__CLOUD_RUN_SERVICE_NAME__/u);
  assert.match(template, /__ARTIFACT_REGISTRY_IMAGE_URI__/u);
  assert.match(template, /__COMMIT_SHA__/u);
  assert.match(template, /__GCP_PROJECT_ID__/u);
  assert.match(template, /__GCP_PROJECT_NUMBER__/u);
  assert.match(template, /containerPort: 8080/u);
  assert.match(template, /name: MEMORY_BACKEND\s+value: firestore/u);
  assert.match(template, /name: PERSISTENCE_BACKEND\s+value: firestore/u);
  assert.match(template, /name: FIRESTORE_DATABASE_ID\s+value: "\(default\)"/u);
  assert.match(template, /name: FIRESTORE_WORKSPACE_COLLECTION/u);
  assert.match(template, /name: FIRESTORE_TASK_COLLECTION/u);
  assert.match(template, /name: FIRESTORE_GITHUB_SESSION_COLLECTION/u);
  assert.match(template, /name: FIRESTORE_GOOGLE_SESSION_COLLECTION/u);
  assert.match(template, /name: FIRESTORE_MCP_GRANT_COLLECTION/u);
  assert.match(template, /name: FIRESTORE_MCP_REPLAY_COLLECTION/u);
  assert.match(template, /name: AUTH_BACKEND\s+value: identity-platform/u);
  assert.match(template, /name: IDENTITY_PLATFORM_PROJECT_ID/u);
  assert.match(
    template,
    /name: IDENTITY_PLATFORM_REQUIRE_EMAIL_VERIFICATION\s+value: "true"/u,
  );
  assert.match(template, /__IDENTITY_PLATFORM_API_KEY_SECRET__/u);
  assert.match(template, /__USER_SESSION_ENCRYPTION_KEY_SECRET__/u);
  assert.match(template, /run\.googleapis\.com\/secrets:/u);
  assert.match(template, /run\.googleapis\.com\/ingress: all/u);
  assert.match(template, /autoscaling\.knative\.dev\/minScale: "0"/u);
  assert.match(template, /autoscaling\.knative\.dev\/maxScale: "2"/u);
  assert.equal((template.match(/path: \/health/gu) || []).length, 2);
  assert.match(template, /startupProbe:/u);
  assert.match(template, /livenessProbe:/u);
  assert.doesNotMatch(template, /readinessProbe:/u);
  assert.match(template, /name: SYNCHRON_TEST_INVITE_CODE/u);
  assert.doesNotMatch(template, /name: TESTER_INVITE_CODE/u);
  assert.equal((template.match(/secretKeyRef:/gu) || []).length, 8);
  assert.doesNotMatch(template, /gcloud\s+(run|secrets)/iu);
});

test("Google Cloud catalog preserves data, secret and deployment boundaries", async () => {
  const [catalog, firestoreIndexes] = await Promise.all([
    read("../docs/GOOGLE_CLOUD_CONFIGURATION_CATALOG.md"),
    read("../firestore.indexes.json"),
  ]);

  for (const marker of [
    "OpenSearch остава authoritative",
    "Supabase остава authoritative",
    "Firestore",
    "Identity Platform",
    "Vertex AI",
    "Secret Manager",
    "DNS",
    "production import",
    "Cloud Run health contract",
    "Migration gates",
  ]) {
    assert.match(catalog, new RegExp(marker, "u"));
  }

  assert.match(catalog, /Firestore runtime\s+adapter-ът/u);
  assert.match(catalog, /PERSISTENCE_BACKEND/u);
  assert.match(catalog, /owner isolation/u);
  assert.match(catalog, /Няма миграция на\s+Supabase users/u);
  assert.match(catalog, /няма\s+secret\s+стойност/u);
  const indexConfiguration = JSON.parse(firestoreIndexes);
  assert.ok(
    indexConfiguration.indexes.some(
      (index) =>
        index.collectionGroup === "synchron-conversation-memory-v1" &&
        index.fields.some((field) => field.fieldPath === "sessionId") &&
        index.fields.some(
          (field) =>
            field.fieldPath === "createdAt" && field.order === "DESCENDING",
        ),
    ),
  );
  for (const collectionGroup of [
    "synchron-github-sessions-v1",
    "synchron-google-sessions-v1",
  ]) {
    assert.ok(
      indexConfiguration.indexes.some(
        (index) =>
          index.collectionGroup === collectionGroup &&
          index.fields.some(
            (field) => field.fieldPath === "firestoreProvider",
          ) &&
          index.fields.some(
            (field) =>
              field.fieldPath === "updatedAt" && field.order === "DESCENDING",
          ),
      ),
    );
  }
});
