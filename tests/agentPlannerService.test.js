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

test("planner uses OpenAI Responses as the primary provider", async () => {
  let digitalOceanCalls = 0;
  const requests = await planCapabilities({
    agentUrl: "https://agent.test",
    agentKey: "agent-key",
    openAiApiKey: "openai-key",
    message: "Провери Supabase.",
    fetchImpl: async (url, options) => {
      if (String(url).includes("/api/v1/chat/completions")) {
        digitalOceanCalls += 1;
        throw new Error("DigitalOcean should be a fallback only.");
      }
      assert.equal(url, "https://api.openai.com/v1/responses");
      const body = JSON.parse(options.body);
      assert.equal(body.model, "gpt-5.6-luna");
      return new Response(
        JSON.stringify({
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: '{"calls":[{"capability":"database.status","request":"Провери статуса на Supabase."}]}',
                },
              ],
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  assert.equal(digitalOceanCalls, 0);
  assert.equal(requests[0].capability, "database.status");
});

test("planner falls back to DigitalOcean when OpenAI is unavailable", async () => {
  const calledUrls = [];
  const requests = await planCapabilities({
    agentUrl: "https://agent.test",
    agentKey: "agent-key",
    openAiApiKey: "openai-key",
    message: "Провери Supabase.",
    fetchImpl: async (url) => {
      calledUrls.push(String(url));
      if (String(url).includes("api.openai.com")) {
        return new Response("temporary failure", { status: 503 });
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content:
                  '{"calls":[{"capability":"database.status","request":"Провери Supabase."}]}',
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  assert.equal(calledUrls.length, 2);
  assert.match(calledUrls[0], /api\.openai\.com\/v1\/responses/u);
  assert.match(calledUrls[1], /agent\.test\/api\/v1\/chat\/completions/u);
  assert.equal(requests[0].capability, "database.status");
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

test("planner accepts the read-only Supabase status capability", () => {
  assert.deepEqual(
    sanitizeCapabilityPlan(
      {
        calls: [
          {
            capability: "database.status",
            request: "Провери статуса на Supabase.",
          },
        ],
      },
      "Провери Supabase.",
    ),
    [
      {
        capability: "database.status",
        action: "database.read",
        message: "Провери статуса на Supabase.",
      },
    ],
  );
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
