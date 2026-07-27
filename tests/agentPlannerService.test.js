import assert from "node:assert/strict";
import test from "node:test";

import {
  planCapabilities,
  sanitizeCapabilityPlan,
  shouldUseAgentPlanner,
} from "../src/services/agentPlannerService.js";

test("planner keeps temporary calendar text inside a memory request out of tools", async () => {
  const requests = await planCapabilities({
    agentUrl: "https://agent.test",
    agentKey: "test-key",
    message: [
      "Запомни като постоянна памет следните факти.",
      "Временна информация: утре трябва да проверя календара — не записвай това като постоянен факт.",
      "Преди запис изчакай моето потвърждение.",
    ].join(" "),
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      assert.equal(request.stream, false);
      assert.match(request.messages[0].content, /Само споменаване/u);
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"calls":[]}' } }],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    },
  });

  assert.deepEqual(requests, []);
});

test("planner creates a single GitHub read and write plan for one implementation task", async () => {
  const message =
    "Провери main и промени цвета на бутона Памет в GitHub хранилището.";
  const requests = await planCapabilities({
    agentUrl: "https://agent.test",
    agentKey: "test-key",
    message,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: [
                  "```json",
                  '{"calls":[',
                  '{"capability":"code.read","request":"Провери актуалния main и бутона Памет."},',
                  '{"capability":"code.write","request":"Промени цвета на бутона Памет."},',
                  '{"capability":"code.write","request":"Промени цвета на бутона Памет."}',
                  "]}",
                  "```",
                ].join("\n"),
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
  });

  assert.deepEqual(
    requests.map(({ capability, message: requestMessage }) => ({
      capability,
      message: requestMessage,
    })),
    [
      {
        capability: "code.read",
        message: "Провери актуалния main и бутона Памет.",
      },
      { capability: "code.write", message },
    ],
  );
});

test("sanitizer rejects unknown capabilities and keeps valid scopes", () => {
  const requests = sanitizeCapabilityPlan(
    {
      calls: [
        {
          capability: "memory.read",
          request: "Провери проектната памет.",
          scope: "project",
        },
        { capability: "payment.execute", request: "Плати." },
      ],
    },
    "Заявка",
  );

  assert.deepEqual(requests, [
    {
      capability: "memory.read",
      action: "memory.read",
      message: "Провери проектната памет.",
      scope: "project",
    },
  ]);
});

test("planner is used for likely tool requests but not ordinary conversation", () => {
  assert.equal(
    shouldUseAgentPlanner("Покажи календара ми за утре.", [
      { capability: "calendar.read" },
    ]),
    true,
  );
  assert.equal(shouldUseAgentPlanner("Как си днес?", []), false);
});
