import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCapabilityReplies,
  buildMemoryReply,
  detectCapabilityRequests,
  executeDetectedCapabilities,
  extractConfirmedMemoryWriteCommands,
  splitCapabilitySubtasks,
} from "../src/routes/chat.js";

test("detects multiple capability subtasks in one message", () => {
  const requests = detectCapabilityRequests(
    "Провери календара и GitHub commit-ите от днес.",
  );
  assert.deepEqual(
    requests.map(({ capability, action }) => ({ capability, action })),
    [
    { capability: "calendar.read", action: "calendar.read" },
    { capability: "code.read", action: "github.read" },
    ],
  );
});

test("splits a complex command into independent subtasks", () => {
  const subtasks = splitCapabilitySubtasks(
    "1) Провери GitHub последните commit-и; 2) Провери GitHub подробностите за последния commit.\n3) Провери GitHub кои файлове са пипани.",
  );
  assert.deepEqual(subtasks, [
    "Провери GitHub последните commit-и",
    "Провери GitHub подробностите за последния commit.",
    "Провери GitHub кои файлове са пипани.",
  ]);
});

test("executes all detected subtasks sequentially even after a failure", async () => {
  const calls = [];
  const results = await executeDetectedCapabilities(
    "Провери календара и GitHub.",
    async (capability, _options) => {
      calls.push(capability);
      if (capability === "calendar.read") {
        throw new Error("calendar temporary failure");
      }
      return {
        output: "GitHub result",
        permission: { decision: "allow" },
        tool: { id: "github-read" },
      };
    },
  );

  assert.deepEqual(calls, ["calendar.read", "code.read"]);
  assert.equal(results.length, 2);
  assert.equal(results[0].status, "rejected");
  assert.equal(results[0].error.message, "calendar temporary failure");
  assert.equal(results[1].status, "fulfilled");
  assert.equal(results[1].result.output, "GitHub result");
});

test("complex 5-check command runs all checks, merges results, and asks memory-write confirmation", async () => {
  const message =
    [
      "Провери GitHub последните commit-и;",
      "Провери GitHub подробности за последния commit;",
      "Провери GitHub променените файлове;",
      "Провери GitHub историята за днес;",
      "Провери GitHub последната реална промяна;",
      "Запомни, че трябва да пуснем деплой след merge.",
    ].join(" ");

  const calls = [];
  const results = await executeDetectedCapabilities(message, async (capability, options) => {
    calls.push({ capability, message: options.message });
    return {
      output: `Result ${calls.length}: ${options.message}`,
      permission: { decision: "allow" },
      tool: { id: "github-read" },
    };
  });

  assert.equal(calls.length, 5);
  assert.deepEqual(
    calls.map((call) => call.capability),
    ["code.read", "code.read", "code.read", "code.read", "code.read"],
  );

  const capabilityReplies = buildCapabilityReplies(results);
  assert.equal(capabilityReplies.length, 5);
  assert.match(capabilityReplies[0], /Result 1/u);
  assert.match(capabilityReplies[4], /Result 5/u);

  const memoryReply = buildMemoryReply({
    type: "write-confirmation-required",
    items: [{ fact: "трябва да пуснем деплой след merge" }],
  });
  assert.match(memoryReply, /Искаш запис в постоянната памет/u);
  assert.match(memoryReply, /За потвърждение изпрати точно/u);

  const fullReply = [memoryReply, ...capabilityReplies].join("\n\n");
  assert.match(fullReply, /Result 1/u);
  assert.match(fullReply, /Result 5/u);
  assert.match(fullReply, /потвърждение/u);

  assert.deepEqual(
    extractConfirmedMemoryWriteCommands(
      "Запомни, че трябва да пуснем деплой след merge.",
    ),
    [],
  );
});

test("requires explicit memory-write confirmation prefix", () => {
  const commands = extractConfirmedMemoryWriteCommands(
    "Потвърждавам запис в постоянната памет: Запомни, че проектът е SYNCHRON-X.",
  );
  assert.deepEqual(commands, [
    { fact: "проектът е SYNCHRON-X", scope: "personal" },
  ]);
  assert.deepEqual(
    extractConfirmedMemoryWriteCommands(
      "Запомни, че проектът е SYNCHRON-X.",
    ),
    [],
  );
});
