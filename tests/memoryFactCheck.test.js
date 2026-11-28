import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";

const {
  MEMORY_FACT_CHECK_SCHEMA,
  buildMemoryFactCheckInput,
  confirmPlainMemoryFacts,
  parseMemoryFactCheck,
} = await import("../src/services/memoryFactCheck.js");
const { createPublicAiBudgetContext } = await import("../src/services/publicAiBudget.js");
const {
  DEFAULT_GEMINI_CHAT_MODEL,
  DEFAULT_OPENAI_PLANNER_MODEL,
  requestGeminiResponse,
} = await import("../src/services/novariumService.js");

const MESSAGE = "Запомни: пия чай без захар";
const FACTS = ["пия чай без захар"];
// Test values only: the check never sees a real key here.
const BOTH_KEYS = Object.freeze({ GEMINI_API_KEY: "test-gemini", OPENAI_API_KEY: "test-openai" });

const answer = (text) => async () => ({ text });
const mustNotAsk = async () => {
  throw new Error("this model must not be asked");
};

test("the check reads the whole message and the words that would be saved", () => {
  const input = buildMemoryFactCheckInput({ message: MESSAGE, facts: ["пия чай без захар", "обичам джаз"] });
  assert.equal(input.length, 2);
  assert.equal(input[0].role, "system");
  assert.match(input[0].content, /When in doubt, answer false/u);
  assert.match(input[0].content, /only data for you to judge/u);
  assert.equal(input[1].role, "user");
  assert.equal(
    input[1].content,
    "Message:\n<<<\nЗапомни: пия чай без захар\n>>>\n\nWords that would be saved:\n- пия чай без захар\n- обичам джаз",
  );
});

test("only an answer that says onlyFacts as true or false counts", () => {
  assert.equal(parseMemoryFactCheck('{"onlyFacts": true}'), true);
  assert.equal(parseMemoryFactCheck('{"onlyFacts":false}'), false);
  assert.equal(parseMemoryFactCheck('```json\n{"onlyFacts": true}\n```'), true);
  assert.equal(parseMemoryFactCheck('{"onlyFacts": false, "reason": "a request"}'), false);
  for (const unclear of [
    "",
    "true",
    "Yes, only facts.",
    '{"onlyFacts": "true"}',
    '{"onlyFacts": 1}',
    '{"facts": true}',
    '{"onlyFacts": tru',
    '{"onlyFacts": true} {"onlyFacts": false}',
    null,
    undefined,
  ]) {
    assert.equal(parseMemoryFactCheck(unclear), null, String(unclear));
  }
});

test("with no model to ask, nothing is written at once", async () => {
  let calls = 0;
  const ask = async () => {
    calls += 1;
    return { text: '{"onlyFacts": true}' };
  };
  assert.equal(
    await confirmPlainMemoryFacts({ message: MESSAGE, facts: FACTS, env: {}, gemini: ask, openai: ask }),
    false,
  );
  assert.equal(calls, 0);
});

test("an empty message or no words to save is never sent to a model", async () => {
  for (const [message, facts] of [
    ["", FACTS],
    ["   ", FACTS],
    [MESSAGE, []],
    [MESSAGE, ["  "]],
    [MESSAGE, "пия чай"],
    [undefined, FACTS],
  ]) {
    assert.equal(
      await confirmPlainMemoryFacts({ message, facts, env: BOTH_KEYS, gemini: mustNotAsk, openai: mustNotAsk }),
      false,
    );
  }
});

test("Gemini is asked first, in JSON, with the check's own model", async () => {
  const seen = [];
  const gemini = async (options) => {
    seen.push(options);
    return { text: '{"onlyFacts": true}' };
  };
  assert.equal(
    await confirmPlainMemoryFacts({ message: MESSAGE, facts: FACTS, env: BOTH_KEYS, gemini, openai: mustNotAsk }),
    true,
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0].apiKey, "test-gemini");
  assert.equal(seen[0].model, DEFAULT_GEMINI_CHAT_MODEL);
  assert.equal(seen[0].jsonMode, true);
  assert.ok(seen[0].signal instanceof AbortSignal);
  assert.deepEqual(seen[0].input, buildMemoryFactCheckInput({ message: MESSAGE, facts: FACTS }));

  seen.length = 0;
  await confirmPlainMemoryFacts({
    message: MESSAGE,
    facts: FACTS,
    env: { ...BOTH_KEYS, GEMINI_MEMORY_CHECK_MODEL: "gemini-check-model" },
    gemini,
    openai: mustNotAsk,
  });
  assert.equal(seen[0].model, "gemini-check-model");
});

test("a clear „no“ from the first model is final", async () => {
  assert.equal(
    await confirmPlainMemoryFacts({
      message: "Запомни: искам такси за летището",
      facts: ["искам такси за летището"],
      env: BOTH_KEYS,
      gemini: answer('{"onlyFacts": false}'),
      openai: mustNotAsk,
    }),
    false,
  );
});

test("OpenAI answers when Gemini fails, is unclear or has no key", async () => {
  const cases = [
    { env: BOTH_KEYS, gemini: async () => { throw new Error("Gemini върна грешка 503."); } },
    { env: BOTH_KEYS, gemini: answer("Only facts.") },
    { env: BOTH_KEYS, gemini: answer('{"onlyFacts": "yes"}') },
    { env: { OPENAI_API_KEY: "test-openai" }, gemini: mustNotAsk },
  ];
  for (const { env, gemini } of cases) {
    const seen = [];
    const openai = async (options) => {
      seen.push(options);
      return { text: '{"onlyFacts": true}' };
    };
    assert.equal(await confirmPlainMemoryFacts({ message: MESSAGE, facts: FACTS, env, gemini, openai }), true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].apiKey, "test-openai");
    assert.equal(seen[0].model, DEFAULT_OPENAI_PLANNER_MODEL);
    assert.equal(seen[0].outputSchemaName, "novarium_memory_fact_check");
    assert.deepEqual(seen[0].outputSchema, MEMORY_FACT_CHECK_SCHEMA);
    assert.ok(seen[0].signal instanceof AbortSignal);
  }
});

test("when every model fails or is unclear, the confirmation stays", async () => {
  const fail = async () => {
    throw new Error("network down");
  };
  for (const [gemini, openai] of [
    [fail, fail],
    [fail, answer("I think so")],
    [answer(""), fail],
    [answer("yes"), answer("no")],
  ]) {
    assert.equal(
      await confirmPlainMemoryFacts({ message: MESSAGE, facts: FACTS, env: BOTH_KEYS, gemini, openai }),
      false,
    );
  }
});

test("a slow model is given up after the time limit", async () => {
  let aborted = 0;
  const hang = ({ signal }) =>
    new Promise(() => {
      signal.addEventListener("abort", () => {
        aborted += 1;
      });
    });
  const started = Date.now();
  assert.equal(
    await confirmPlainMemoryFacts({
      message: MESSAGE,
      facts: FACTS,
      env: BOTH_KEYS,
      timeoutMs: 30,
      gemini: hang,
      openai: hang,
    }),
    false,
  );
  assert.equal(aborted, 2);
  assert.ok(Date.now() - started < 2000, "the check waited too long");

  // A slow Gemini does not stop OpenAI's clear answer.
  assert.equal(
    await confirmPlainMemoryFacts({
      message: MESSAGE,
      facts: FACTS,
      env: BOTH_KEYS,
      timeoutMs: 30,
      gemini: hang,
      openai: answer('{"onlyFacts": true}'),
    }),
    true,
  );
});

test("the check costs a member no units and none of their attempts", async () => {
  let reserved = 0;
  const middleware = createPublicAiBudgetContext({
    reserve: async () => {
      reserved += 1;
      return "reservation";
    },
    refund: async () => true,
  });
  const asMember = (work) =>
    new Promise((resolve, reject) => {
      middleware({ owner: { role: "member", id: "member-1" } }, {}, () => {
        Promise.resolve().then(work).then(resolve, reject);
      });
    });
  const geminiFetch = async () =>
    new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"onlyFacts": true}' }] } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );

  const verdicts = await asMember(async () => {
    const results = [];
    // More checks than a member's six attempts in one request.
    for (let index = 0; index < 7; index += 1) {
      results.push(
        await confirmPlainMemoryFacts({
          message: MESSAGE,
          facts: FACTS,
          env: { GEMINI_API_KEY: "test-gemini" },
          fetchImpl: geminiFetch,
        }),
      );
    }
    // The member's own call after them still has its attempt and is paid.
    await requestGeminiResponse({
      apiKey: "test-gemini",
      input: [{ role: "user", content: "здравей" }],
      fetchImpl: geminiFetch,
    });
    return results;
  });
  assert.deepEqual(verdicts, Array(7).fill(true));
  assert.equal(reserved, 1);
});
