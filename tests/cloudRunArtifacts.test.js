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
  assert.match(dockerignore, /^\.git$/mu);
});

test("Cloud Run template uses liveness without dependency-heavy readiness", async () => {
  const template = await read("../deploy/cloud-run/service.yaml.template");

  assert.match(template, /__CLOUD_RUN_SERVICE_NAME__/u);
  assert.match(template, /__ARTIFACT_REGISTRY_IMAGE_URI__/u);
  assert.match(template, /__COMMIT_SHA__/u);
  assert.match(template, /containerPort: 8080/u);
  assert.equal((template.match(/path: \/health/gu) || []).length, 2);
  assert.match(template, /startupProbe:/u);
  assert.match(template, /livenessProbe:/u);
  assert.doesNotMatch(template, /readinessProbe:/u);
  assert.doesNotMatch(template, /valueFrom:/u);
  assert.doesNotMatch(template, /secretKeyRef:/u);
  assert.doesNotMatch(template, /gcloud\s+(run|secrets)/iu);
});

test("Google Cloud catalog preserves data, secret and deployment boundaries", async () => {
  const catalog = await read("../docs/GOOGLE_CLOUD_CONFIGURATION_CATALOG.md");

  for (const marker of [
    "OpenSearch остава authoritative",
    "Supabase остава authoritative",
    "Firestore",
    "Identity Platform",
    "Vertex AI",
    "Secret Manager",
    "DNS",
    "data migration",
    "Cloud Run health contract",
    "Migration gates",
  ]) {
    assert.match(catalog, new RegExp(marker, "u"));
  }

  assert.match(catalog, /Vertex AI има само изолиран\s+opt-in adapter/u);
  assert.match(catalog, /Firestore и Identity Platform са planning-only/u);
  assert.match(catalog, /Няма миграция на\s+Supabase users/u);
  assert.match(catalog, /няма secret\s+стойност/u);
});
