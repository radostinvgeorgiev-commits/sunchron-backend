import assert from "node:assert/strict";
import test from "node:test";

import {
  buildVertexOpenModelEndpoint,
  probeVertexOpenModels,
  requestVertexOpenModel,
} from "../src/services/vertexOpenModelsService.js";

const ENV = { K_SERVICE: "svc", GOOGLE_CLOUD_PROJECT: "project-123" };
const authClient = { getRequestHeaders: async () => ({ Authorization: "Bearer t" }) };

test("open models use the OpenAI-style Vertex endpoint per region", () => {
  assert.equal(
    buildVertexOpenModelEndpoint({ projectId: "project-123", location: "global" }),
    "https://aiplatform.googleapis.com/v1/projects/project-123/locations/global/endpoints/openapi/chat/completions",
  );
  assert.equal(
    buildVertexOpenModelEndpoint({ projectId: "project-123", location: "us-east5" }),
    "https://us-east5-aiplatform.googleapis.com/v1/projects/project-123/locations/us-east5/endpoints/openapi/chat/completions",
  );
});

test("an open model answer comes back with its text and cut-off flag", async () => {
  let sent;
  const result = await requestVertexOpenModel({
    env: ENV,
    model: "meta/llama-3.3-70b-instruct-maas",
    location: "us-central1",
    input: [{ role: "user", content: "Здравей" }],
    authClient,
    fetchImpl: async (url, options) => {
      sent = { url, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({ choices: [{ message: { content: "Здрасти" }, finish_reason: "length" }] }));
    },
  });
  assert.equal(result.text, "Здрасти");
  assert.equal(result.truncated, true);
  assert.equal(sent.body.model, "meta/llama-3.3-70b-instruct-maas");
  assert.match(sent.url, /us-central1-aiplatform/u);
});

test("Google's own reason comes back with the error", async () => {
  await assert.rejects(
    requestVertexOpenModel({
      env: ENV,
      model: "x/y",
      location: "global",
      input: "hi",
      authClient,
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: { status: "PERMISSION_DENIED", message: "Model not enabled", details: [{ reason: "MODEL_NOT_ENABLED" }] } }), { status: 403 }),
    }),
    (error) => error.code === "VERTEX_OPEN_MODEL_FORBIDDEN" && error.reason === "MODEL_NOT_ENABLED: Model not enabled",
  );
});

test("the probe stops trying when its time is used up", async () => {
  const results = await probeVertexOpenModels({ env: ENV, budgetMs: 0, ask: async () => ({ text: "7" }) });
  assert.ok(results.every(({ ok, errors }) => !ok && errors.every((item) => item.includes("не стигна времето"))));
});

test("a missing model is reported, not thrown as a crash", async () => {
  await assert.rejects(
    requestVertexOpenModel({
      env: ENV,
      model: "x/y",
      location: "global",
      input: "hi",
      authClient,
      fetchImpl: async () => new Response("{}", { status: 404 }),
    }),
    (error) => error.code === "VERTEX_OPEN_MODEL_NOT_FOUND",
  );
  await assert.rejects(
    requestVertexOpenModel({ env: {}, model: "x/y", location: "global", input: "hi", authClient }),
    (error) => error.code === "VERTEX_OPEN_MODEL_DISABLED",
  );
});

test("the probe tries each region in turn and says which models answer", async () => {
  const results = await probeVertexOpenModels({
    env: ENV,
    marker: "42",
    ask: async ({ model, location }) => {
      if (model.startsWith("meta/llama-4") && location === "us-east5") throw Object.assign(new Error(), { code: "VERTEX_OPEN_MODEL_NOT_FOUND" });
      if (model.startsWith("zai-org/")) throw Object.assign(new Error(), { code: "VERTEX_OPEN_MODEL_FORBIDDEN" });
      return { text: "42" };
    },
  });
  const maverick = results.find(({ model }) => model.startsWith("meta/llama-4"));
  assert.equal(maverick.ok, true);
  assert.equal(maverick.location, "global");
  const glm = results.find(({ model }) => model.startsWith("zai-org/"));
  assert.equal(glm.ok, false);
  assert.equal(glm.errors.length, 1);
});
