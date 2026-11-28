import assert from "node:assert/strict";
import test from "node:test";

import {
  MCP_TOOLS,
  createMcpRequestHandler,
  isValidMcpToken,
} from "../src/services/mcpReadService.js";

test("MCP token validation is fail-closed", () => {
  const token = "a".repeat(48);
  assert.equal(isValidMcpToken(`Bearer ${token}`, token), true);
  assert.equal(isValidMcpToken(`Bearer ${token}x`, token), false);
  assert.equal(isValidMcpToken("", token), false);
});

test("MCP exposes Google Cloud and no retired provider or Copilot tools", () => {
  const names = MCP_TOOLS.map(({ name }) => name);
  assert.ok(names.includes("get_google_cloud_runtime_status"));
  assert.ok(names.includes("get_system_configuration"));
  assert.ok(names.includes("get_google_cloud_project_diagnostics"));
  assert.equal(
    names.some((name) => /digitalocean|cloudflare|copilot/iu.test(name)),
    false,
  );
});

test("MCP returns the verified Google Cloud runtime and audits the read", async () => {
  const events = [];
  const handle = createMcpRequestHandler({
    getGoogleCloudStatus: async () => ({
      provider: "google-cloud",
      configured: true,
      cloudRunDetected: true,
      projectId: "project-1",
      service: "novarium",
      revision: "novarium-42",
      region: "europe-west1",
      canonicalOrigin: "https://cloudaicore.com",
      memoryBackend: "firestore",
      persistenceBackend: "firestore",
      authBackend: "identity-platform",
    }),
    audit: async (event) => events.push(event),
  });
  const response = await handle(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "get_google_cloud_runtime_status", arguments: {} },
    },
    "owner-1",
    { role: "owner" },
  );
  assert.equal(response.result.structuredContent.provider, "google-cloud");
  assert.match(response.result.content[0].text, /Cloud Run: потвърден/u);
  assert.equal(events[0].action, "infrastructure.read");
});

test("MCP initialization describes the confirmation boundary", async () => {
  const handle = createMcpRequestHandler({ audit: async () => {} });
  const response = await handle({
    jsonrpc: "2.0",
    id: 2,
    method: "initialize",
  });
  assert.match(response.result.instructions, /еднократно потвърждение/u);
  assert.doesNotMatch(
    response.result.instructions,
    /DigitalOcean|Cloudflare|Copilot/iu,
  );
});

test("talk_to_novarium returns a drawn picture as the picture itself, not as text", async () => {
  const handle = createMcpRequestHandler({
    audit: async () => {},
    runAgentConversation: async () => ({
      sessionId: "s-1",
      response: "Нарисувах картинката: Рижа котка",
      image: { mimeType: "image/webp", data: "UklGRg==" },
      capabilities: ["image.generate"],
    }),
  });
  const response = await handle(
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "talk_to_novarium", arguments: { message: "нарисувай ми котка" } },
    },
    "owner-1",
    { role: "owner", memoryOwnerId: "owner-1" },
  );
  const { content, structuredContent } = response.result;
  assert.equal(content[0].text, "Нарисувах картинката: Рижа котка");
  assert.deepEqual(content.at(-1), { type: "image", data: "UklGRg==", mimeType: "image/webp" });
  // The picture's bytes are not repeated in the text.
  assert.equal("image" in structuredContent, false);
  assert.ok(content.slice(0, -1).every((item) => item.type === "text" && !item.text.includes("UklGRg==")));
});
