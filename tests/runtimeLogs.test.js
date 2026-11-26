import assert from "node:assert/strict";
import test from "node:test";

import { readRuntimeLogs, redactLogText } from "../src/services/runtimeLogService.js";
import { createMcpCapabilityHandler, MCP_CAPABILITY_TOOLS } from "../src/services/mcpCapabilityService.js";
import { MCP_AUDIT_READ_SCOPE, requiredScopesForMcpTool } from "../src/services/mcpOAuthService.js";

const env = { GOOGLE_CLOUD_PROJECT: "handy-boulevard-479120-q9", K_SERVICE: "synchron-backend-google" };

test("secrets, tokens and emails are redacted from log lines", () => {
  const text = redactLogText(
    "key sk-ant-api03-abcdefghijklmnop AIzaSyC3fphFkjY7qD-FA5X5fpY_qHkVU Bearer abc.def ghp_abcdefghijklmnopqrstuvwxyz ivo@example.test password=hunter2 [Claude] Upstream request failed: 401",
  );
  assert.doesNotMatch(text, /sk-ant|AIzaSy|abc\.def|ghp_|ivo@|hunter2/u);
  assert.match(text, /\[Claude\] Upstream request failed: 401/u);
});

test("logs are read for the configured service with a bounded filter", async () => {
  let request;
  const result = await readRuntimeLogs(
    { minutes: 30, severity: "ERROR", limit: 5, contains: "Claude" },
    {
      env,
      now: () => Date.UTC(2026, 10, 25, 1, 0, 0),
      accessTokenProvider: async () => "token",
      fetchImpl: async (url, options) => {
        request = { url, body: JSON.parse(options.body), auth: options.headers.Authorization };
        return Response.json({
          entries: [
            {
              timestamp: "2026-11-25T00:59:00Z",
              severity: "ERROR",
              textPayload: "[Claude] Upstream request failed: 401 sk-ant-secretsecretsecret",
              resource: { labels: { revision_name: "rev-1" } },
            },
          ],
        });
      },
    },
  );
  assert.equal(request.url, "https://logging.googleapis.com/v2/entries:list");
  assert.equal(request.auth, "Bearer token");
  assert.deepEqual(request.body.resourceNames, ["projects/handy-boulevard-479120-q9"]);
  assert.match(request.body.filter, /resource\.labels\.service_name="synchron-backend-google"/u);
  assert.match(request.body.filter, /severity>=ERROR/u);
  assert.match(request.body.filter, /timestamp>="2026-11-25T00:30:00\.000Z"/u);
  assert.match(request.body.filter, /"Claude"/u);
  assert.equal(request.body.pageSize, 5);
  assert.equal(result.entries[0].revision, "rev-1");
  assert.doesNotMatch(result.entries[0].text, /sk-ant/u);
});

test("filter injection and missing configuration are refused", async () => {
  await assert.rejects(
    readRuntimeLogs({ contains: 'x" OR severity>=DEFAULT' }, { env, accessTokenProvider: async () => "t" }),
    { code: "RUNTIME_LOGS_INVALID_FILTER" },
  );
  await assert.rejects(readRuntimeLogs({}, { env: {} }), { code: "RUNTIME_LOGS_UNAVAILABLE" });
  await assert.rejects(
    readRuntimeLogs({}, { env, accessTokenProvider: async () => "t", fetchImpl: async () => new Response("", { status: 403 }) }),
    { code: "RUNTIME_LOGS_FORBIDDEN" },
  );
});

test("the MCP log tool is owner-only and read-only", async () => {
  const definition = MCP_CAPABILITY_TOOLS.find((item) => item.name === "read_runtime_logs");
  assert.ok(definition);
  assert.equal(definition.annotations.readOnlyHint, true);
  assert.deepEqual(requiredScopesForMcpTool("read_runtime_logs"), [MCP_AUDIT_READ_SCOPE]);
  const handler = createMcpCapabilityHandler({
    audit: async () => {},
    dependencies: { readRuntimeLogs: async () => ({ count: 0, minutes: 60, entries: [] }) },
  });
  await assert.rejects(
    handler("read_runtime_logs", {}, { ownerId: "member", identity: { role: "member" } }),
  );
  const { result } = await handler("read_runtime_logs", {}, { ownerId: "owner", identity: { role: "owner" } });
  assert.equal(result.structuredContent.count, 0);
  // Clients that only read `content` still get the entries as JSON.
  assert.deepEqual(JSON.parse(result.content[1].text), result.structuredContent);
});
