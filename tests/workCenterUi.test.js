import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const script = await readFile(new URL("../public/work-center.js", import.meta.url), "utf8");

test("work center describes only current Google Cloud runtime", () => {
  assert.match(script, /Google Cloud|Firestore|Identity Platform/u);
  assert.doesNotMatch(script, /DigitalOcean|Cloudflare|OpenSearch|Supabase/u);
  assert.doesNotMatch(script, /digitalOcean|cloudflare|opensearch|supabase/u);
});

test("work center keeps GitHub and Google actions behind live status and confirmation", () => {
  assert.match(script, /GitHub Read/u);
  assert.match(script, /Google Calendar/u);
  assert.match(script, /fetch\([\s\S]*health\/integrations/u);
  assert.match(script, /confirm/u);
});
