import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMemoryReply,
  detectCapabilityRequests,
  extractConfirmedMemoryDeleteCommand,
  mergeMemoryTaskStatus,
  resolveChatAiSelection,
  shouldReplyWithVerifiedToolOutput,
} from "../src/routes/chat.js";
import { filterCapabilityRequestsForIdentity } from "../src/services/memberCapabilityPolicy.js";

test("chat model selection is explicit, provider-safe, and fail-closed", () => {
  const env = {
    AI_CORE_PROVIDER: "grok",
    OPENAI_API_KEY: "openai-test",
    GEMINI_API_KEY: "gemini-test",
    GROK_API_KEY: "grok-test",
  };

  assert.deepEqual(
    resolveChatAiSelection({ requestedModel: "gemini-2.5-flash", env }),
    {
      provider: "gemini",
      model: "gemini-2.5-flash",
      configured: true,
      workContext: null,
    },
  );
  assert.deepEqual(
    resolveChatAiSelection({ requestedModel: "grok-4.5", env }),
    {
      provider: "grok",
      model: "grok-4.5",
      configured: true,
      workContext: null,
    },
  );
  assert.equal(
    resolveChatAiSelection({
      requestedModel: "gemini-2.5-flash",
      env: { AI_CORE_PROVIDER: "grok", GROK_API_KEY: "grok-test" },
    }).configured,
    false,
  );
});

test("explicit chat model selection overrides the work agent model", () => {
  const env = {
    AI_CORE_PROVIDER: "grok",
    GROK_API_KEY: "grok-test",
    GEMINI_API_KEY: "gemini-test",
  };

  const selection = resolveChatAiSelection({
    interactionMode: "work",
    requestedModel: "gemini-2.5-flash",
    workContext: {
      project: { name: "Тестов проект" },
      agent: { model: "grok-4.5", purpose: "Тестов агент" },
    },
    env,
  });

  assert.equal(selection.provider, "gemini");
  assert.equal(selection.model, "gemini-2.5-flash");
  assert.equal(selection.configured, true);
  assert.equal(selection.workContext?.agent.model, "grok-4.5");
});

test("chat routes memory, calendar and GitHub requests through current capabilities", () => {
  assert.deepEqual(
    detectCapabilityRequests("Провери календара и GitHub commit-ите от днес.").map(({ capability }) => capability),
    ["calendar.read", "code.read"],
  );
  assert.deepEqual(
    detectCapabilityRequests("Провери паметта.").map(({ capability }) => capability),
    ["memory.read"],
  );
});

test("legacy provider requests are not executable capabilities", () => {
  assert.deepEqual(detectCapabilityRequests("Провери Supabase и OpenSearch."), []);
  assert.deepEqual(detectCapabilityRequests("Провери DigitalOcean и Cloudflare."), []);
});

test("member profiles receive only safe personal capabilities", () => {
  const requests = detectCapabilityRequests(
    "Потърси актуална информация, провери паметта и провери GitHub.",
  );
  const allowed = filterCapabilityRequestsForIdentity(requests, { role: "member" });
  assert.deepEqual(allowed.map(({ capability }) => capability), ["memory.read"]);
});

test("memory confirmation keeps the overall task waiting", () => {
  const task = { id: "task-1", status: "completed", verified: true, totalSteps: 0 };
  const waiting = mergeMemoryTaskStatus(task, { type: "write-confirmation-required" });
  assert.equal(waiting.status, "waiting_confirmation");
  assert.equal(waiting.verified, false);
});

test("memory delete requires the exact confirmation phrase", () => {
  assert.deepEqual(
    extractConfirmedMemoryDeleteCommand(
      "потвърждавам изтриването от постоянната памет: моят цвят е син",
    ),
    { fact: "моят цвят е син", scope: "personal" },
  );
  assert.equal(extractConfirmedMemoryDeleteCommand("изтрий паметта"), null);
});

test("verified tool output is used only for successful current tools", () => {
  assert.equal(
    shouldReplyWithVerifiedToolOutput([{ request: { capability: "code.read" } }]),
    true,
  );
  assert.equal(
    shouldReplyWithVerifiedToolOutput([{ request: { capability: "unknown" } }]),
    false,
  );
});

test("memory reply stays provider-neutral and does not mention removed stores", () => {
  const reply = buildMemoryReply({ type: "forgot", deleted: false });
  assert.match(reply, /Не намерих/u);
  assert.doesNotMatch(reply, /OpenSearch|Supabase|DigitalOcean|Cloudflare/u);
});
