import assert from "node:assert/strict";
import test from "node:test";

import {
  MCP_TOOLS,
  createMcpRequestHandler,
  isValidMcpToken,
  safeMcpError,
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

// „Разкачи“ in „Инструменти“ (RADKO 28.11 14:11): a tool the person turned
// off is not used over MCP either, and a confirmed Google step is checked by
// the tool of the step it confirms.
const switchCall = (name, args = {}) => ({
  jsonrpc: "2.0",
  id: 9,
  method: "tools/call",
  params: { name, arguments: args },
});

test("a tool turned off in „Инструменти“ is refused over MCP, and a confirmed Google step by its own tool", async () => {
  const run = async ({ name, args, states, confirmation }) => {
    const asked = [];
    const handle = createMcpRequestHandler({
      audit: async () => {},
      validateConfirmation: async () => {
        if (!confirmation) throw Object.assign(new Error("not found"), { code: "CONFIRMATION_NOT_FOUND" });
        return confirmation;
      },
      toolState: async (ownerId, tool) => {
        asked.push([ownerId, tool]);
        return states[tool] || "on";
      },
    });
    const response = await handle(switchCall(name, args), "owner-1", { role: "owner", memoryOwnerId: "owner-1" });
    return { asked, result: response.result, error: response.error };
  };

  const gmailOff = await run({ name: "search_gmail", args: { query: "банка" }, states: { "gmail-read": "off" } });
  assert.equal(gmailOff.result.isError, true);
  assert.deepEqual(gmailOff.result.structuredContent, { tool: "gmail-read", connected: false });
  assert.match(gmailOff.result.content[0].text, /разкачен в „Инструменти“.*„Свържи“/u);
  assert.deepEqual(gmailOff.asked, [["owner-1", "gmail-read"]]);

  // A contact prepared while Contacts was on: refused once Contacts is off,
  // and Gmail's switch does not decide it.
  const contact = await run({
    name: "confirm_google_action",
    args: { confirmationId: "c-1" },
    states: { "google-contacts": "off" },
    confirmation: { action: "contacts.write:create" },
  });
  assert.deepEqual(contact.asked, [["owner-1", "google-contacts"]]);
  assert.deepEqual(contact.result.structuredContent, { tool: "google-contacts", connected: false });

  const mail = await run({
    name: "confirm_google_action",
    args: { confirmationId: "m-1" },
    states: { "gmail-read": "off" },
    confirmation: { action: "mail.send:message" },
  });
  assert.deepEqual(mail.asked, [["owner-1", "gmail-read"]]);
  assert.equal(mail.result.structuredContent.tool, "gmail-read");

  // The step cannot be read (expired or unknown): nothing runs, and the
  // answer gives that reason, not a switch the step may not even use.
  const unknown = await run({
    name: "confirm_google_action",
    args: { confirmationId: "x-1" },
    states: { "gmail-read": "off", "google-contacts": "off" },
  });
  assert.deepEqual(unknown.asked, []);
  assert.equal(unknown.result, undefined);
  assert.equal(unknown.error?.data?.code, "CONFIRMATION_NOT_FOUND");
  assert.doesNotMatch(unknown.error?.message || "", /разкачен/u);

  // The switches cannot be read: refused for now, and not called the
  // person's choice.
  const unreadable = await run({ name: "list_google_calendar_events", states: { "google-calendar-read": "unavailable" } });
  assert.equal(unreadable.result.isError, true);
  assert.deepEqual(unreadable.result.structuredContent, { tool: "google-calendar-read", connected: false, unavailable: true });
  assert.match(unreadable.result.content[0].text, /не могат да се прочетат сега/u);
  assert.doesNotMatch(unreadable.result.content[0].text, /разкачен/u);
});

test("a confirmed task with a step on a tool turned off says why over MCP", () => {
  const error = Object.assign(new Error("Тази задача ползва инструмент, разкачен в „Инструменти“, затова нищо не е изпълнено."), {
    code: "TOOL_SWITCHED_OFF",
    status: 409,
  });
  assert.deepEqual(safeMcpError(error), {
    code: -32000,
    message: error.message,
    data: { code: "TOOL_SWITCHED_OFF" },
  });
});
