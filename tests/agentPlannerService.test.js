import assert from "node:assert/strict";
import test from "node:test";

import {
  hasExplicitReadOnlyBoundary,
  isReadOnlyIntegrationStatusRequest,
  planCapabilities,
  sanitizeCapabilityPlan,
  shouldUseAgentPlanner,
} from "../src/services/agentPlannerService.js";

test("planner keeps temporary calendar text inside a memory request out of tools", async () => {
  const requests = await planCapabilities({
    openAiApiKey: "openai-key",
    message: [
      "Запомни като постоянна памет следните факти.",
      "Временна информация: утре трябва да проверя календара — не записвай това като постоянен факт.",
      "Преди запис изчакай моето потвърждение.",
    ].join(" "),
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      assert.equal(request.store, false);
      assert.match(request.input[0].content, /Само споменаване/u);
      return new Response(
        JSON.stringify({
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: '{"calls":[]}' }],
            },
          ],
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
    openAiApiKey: "openai-key",
    message,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: [
                    "```json",
                    '{"calls":[',
                    '{"capability":"code.read","request":"Провери актуалния main и бутона Памет."},',
                    '{"capability":"code.write","request":"Промени цвета на бутона Памет."},',
                    '{"capability":"code.write","request":"Промени цвета на бутона Памет."}',
                    "]}",
                    "```",
                  ].join("\n"),
                },
              ],
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
  const requests = await planCapabilities({
    openAiApiKey: "openai-key",
    message: "Провери Supabase.",
    fetchImpl: async (url, options) => {
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

  assert.equal(requests[0].capability, "database.status");
});

test("planner does not call the removed DigitalOcean agent when OpenAI is unavailable", async () => {
  const calledUrls = [];
  await assert.rejects(
    planCapabilities({
      openAiApiKey: "openai-key",
      message: "Провери Supabase.",
      fetchImpl: async (url) => {
        calledUrls.push(String(url));
        return new Response("temporary failure", { status: 503 });
      },
    }),
    (error) => error?.code === "AGENT_PLANNER_UNAVAILABLE",
  );

  assert.equal(calledUrls.length, 1);
  assert.match(calledUrls[0], /api\.openai\.com\/v1\/responses/u);
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

test("planner accepts the read-only Copilot task status capability", () => {
  assert.deepEqual(
    sanitizeCapabilityPlan(
      {
        calls: [
          {
            capability: "code.task-status",
            request: "Провери GitHub задача #83.",
          },
        ],
      },
      "Провери GitHub задача #83.",
    ),
    [
      {
        capability: "code.task-status",
        action: "github.read",
        message: "Провери GitHub задача #83.",
      },
    ],
  );
});

test("planner carries an exact commit SHA into the confirmed Cloud Build trigger action", () => {
  const message =
    "Стартирай Cloud Build deploy за main commit 6dbfb750813c47cca439db5bc3e9a3debbbb5a3a.";
  assert.deepEqual(
    sanitizeCapabilityPlan(
      {
        calls: [
          {
            capability: "infrastructure.googlecloud.write",
            operation: "run_cloud_build_trigger",
            input: {
              commitSha: "6DBFB750813C47CCA439DB5BC3E9A3DEBBBB5A3A",
            },
            request: message,
          },
        ],
      },
      message,
    ),
    [
      {
        capability: "infrastructure.googlecloud.write",
        action: "infrastructure.write",
        message,
        operation: "run_cloud_build_trigger",
        input: {
          commitSha: "6dbfb750813c47cca439db5bc3e9a3debbbb5a3a",
          branch: "main",
        },
      },
    ],
  );
});

test("planner drops Cloud Build trigger runs without an exact commit SHA", () => {
  assert.deepEqual(
    sanitizeCapabilityPlan(
      {
        calls: [
          {
            capability: "infrastructure.googlecloud.write",
            operation: "run_cloud_build_trigger",
            request: "Стартирай deploy на main.",
          },
        ],
      },
      "Стартирай deploy на main.",
    ),
    [],
  );
});

test("planner cannot add GitHub write across an explicit read-only boundary", () => {
  const message =
    "Провери само за четене кой е последният commit в main. Не прави промени.";
  assert.equal(hasExplicitReadOnlyBoundary(message), true);
  assert.deepEqual(
    sanitizeCapabilityPlan(
      {
        calls: [
          { capability: "code.read", request: message },
          { capability: "code.write", request: "Промени проекта" },
        ],
      },
      message,
    ).map(({ capability }) => capability),
    ["code.read"],
  );
});

test("status-only requests block data reads and code writes from the planner", () => {
  const message =
    "Провери Drive, Gmail и Calendar. Покажи само статуса на връзките, без да четеш лични данни и без промени.";

  assert.equal(hasExplicitReadOnlyBoundary(message), true);
  assert.equal(isReadOnlyIntegrationStatusRequest(message), true);
  assert.deepEqual(
    sanitizeCapabilityPlan(
      {
        calls: [
          { capability: "system.integrations.status", request: message },
          { capability: "files.read", request: "Покажи Drive файловете" },
          { capability: "mail.read", request: "Покажи Gmail" },
          { capability: "calendar.read", request: "Покажи календара" },
          { capability: "code.write", request: "Промени проекта" },
        ],
      },
      message,
    ).map(({ capability }) => capability),
    ["system.integrations.status"],
  );
});

test("planner accepts Calendar Write only as a confirmed write action", () => {
  assert.deepEqual(
    sanitizeCapabilityPlan(
      {
        calls: [
          {
            capability: "calendar.write",
            request: "Създай събитие: Среща | 2026-08-05 14:30 | 60",
          },
        ],
      },
      "Създай събитие: Среща | 2026-08-05 14:30 | 60",
    ),
    [
      {
        capability: "calendar.write",
        action: "calendar.write",
        message: "Създай събитие: Среща | 2026-08-05 14:30 | 60",
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
  assert.equal(
    shouldUseAgentPlanner(
      "Напомни ми: Плащане на ток | 2026-08-05 14:30 | 30 минути преди",
      [],
    ),
    true,
  );
  assert.equal(shouldUseAgentPlanner("Как си днес?", []), false);
});
