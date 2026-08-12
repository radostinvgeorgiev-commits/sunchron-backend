import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const envExample = readFileSync(new URL("../.env.example", import.meta.url), "utf8");

test("runtime example selects Google Cloud backends", () => {
  assert.match(envExample, /^MEMORY_BACKEND=firestore$/mu);
  assert.match(envExample, /^PERSISTENCE_BACKEND=firestore$/mu);
  assert.match(envExample, /^AUTH_BACKEND=identity-platform$/mu);
  assert.doesNotMatch(envExample, /^(?:OPENSEARCH|SUPABASE|DIGITALOCEAN|CLOUDFLARE)_/mu);
});

test("runtime example keeps required secrets value-free", () => {
  for (const key of ["OPENAI_API_KEY", "GEMINI_API_KEY", "GROK_API_KEY", "GITHUB_CLIENT_SECRET", "GOOGLE_CLIENT_SECRET"]) {
    assert.match(envExample, new RegExp(`^${key}=(?:$|your-)`, "mu"));
  }
  assert.doesNotMatch(envExample, /sk-[A-Za-z0-9]{20,}/u);
});

test("legacy DigitalOcean deployment manifest is removed from the runtime tree", () => {
  assert.throws(() => readFileSync(new URL("../.do/app.yaml", import.meta.url)));
});
