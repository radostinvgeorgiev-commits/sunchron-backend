import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createEarlyAccessRouter } from "../src/routes/earlyAccessRouter.js";
import { readCampaignAttribution } from "../src/services/campaignAttribution.js";

const campaign = {
  utm_source: "chatgpt",
  utm_medium: "paid",
  utm_campaign: "ai-core-launch",
  utm_content: "variant-2",
};

test("accepts only the configured campaign and omits unrelated request fields", () => {
  assert.deepEqual(
    readCampaignAttribution({ ...campaign, email: "member@example.com" }),
    campaign,
  );
  assert.equal(
    readCampaignAttribution({ ...campaign, utm_content: "member@example.com" }),
    null,
  );
  assert.equal(
    readCampaignAttribution({ ...campaign, utm_source: ["chatgpt"] }),
    null,
  );
  assert.equal(readCampaignAttribution({ utm_source: "chatgpt" }), null);
});

test("logs a successful campaign request once and carries tags through the redirect", async (t) => {
  const info = t.mock.method(console, "info", () => {});
  const app = express();
  let created = false;
  const store = {
    async set() {
      if (created) {
        throw Object.assign(new Error("Duplicate"), {
          upstreamErrorStatus: "ALREADY_EXISTS",
        });
      }
      created = true;
    },
  };
  app.use(
    "/api/early-access",
    createEarlyAccessRouter({ getStore: () => store }),
  );
  const endpoint = `/api/early-access?${new URLSearchParams(campaign)}`;
  const form = {
    email: "member@example.com",
    consent: "yes",
    source: "chatgpt",
  };
  const response = await request(app).post(endpoint).type("form").send(form);

  assert.equal(response.status, 303);
  const location = new URL(
    response.headers.location,
    "https://cloudaicore.com",
  );
  assert.equal(location.searchParams.get("request"), "received");
  assert.deepEqual(
    readCampaignAttribution(Object.fromEntries(location.searchParams)),
    campaign,
  );
  await request(app).post(endpoint).type("form").send(form).expect(303);
  assert.deepEqual(
    info.mock.calls.map(({ arguments: [log] }) => JSON.parse(log)),
    [{ event: "campaign_early_access", ...campaign }],
  );
});
