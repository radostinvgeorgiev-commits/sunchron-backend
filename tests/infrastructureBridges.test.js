import assert from "node:assert/strict";
import test from "node:test";

import {
  getDigitalOceanAppStatus,
  formatDigitalOceanStatus,
} from "../src/services/digitalOceanService.js";
import {
  getCloudflareZoneStatus,
  formatCloudflareStatus,
} from "../src/services/cloudflareService.js";
import { detectCapabilityRequests } from "../src/routes/chat.js";

test("DigitalOcean bridge reads app and deployment status without writes", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes("/deployments")) {
      return Response.json({
        deployments: [{ id: "dep-1", phase: "ACTIVE", cause: "commit" }],
      });
    }
    return Response.json({
      app: {
        id: "app-1",
        spec: { name: "sunchron-backend" },
        live_url: "https://synchron.foundation",
        active_deployment: { id: "dep-1", phase: "ACTIVE" },
      },
    });
  };
  const status = await getDigitalOceanAppStatus({
    env: { DIGITALOCEAN_API_TOKEN: "secret", DIGITALOCEAN_APP_ID: "app-1" },
    fetchImpl,
  });
  assert.equal(status.activeDeployment.phase, "ACTIVE");
  assert.match(formatDigitalOceanStatus(status), /sunchron-backend/u);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => !call.options.method || call.options.method === "GET"));
  assert.doesNotMatch(JSON.stringify(status), /secret/u);
});

test("Cloudflare bridge reads zone and DNS without writes", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes("/dns_records")) {
      return Response.json({
        success: true,
        result: [
          {
            id: "record-1",
            type: "CNAME",
            name: "synchron.foundation",
            content: "example.ondigitalocean.app",
            proxied: true,
            ttl: 1,
          },
        ],
      });
    }
    return Response.json({
      success: true,
      result: { id: "zone-1", name: "synchron.foundation", status: "active" },
    });
  };
  const status = await getCloudflareZoneStatus({
    env: { CLOUDFLARE_API_TOKEN: "secret", CLOUDFLARE_ZONE_ID: "zone-1" },
    fetchImpl,
  });
  assert.equal(status.status, "active");
  assert.match(formatCloudflareStatus(status), /CNAME/u);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => !call.options.method || call.options.method === "GET"));
  assert.doesNotMatch(JSON.stringify(status), /secret/u);
});

test("chat routes infrastructure status requests to the bridges", () => {
  assert.deepEqual(
    detectCapabilityRequests(
      "Провери статуса на DigitalOcean и покажи DNS записите в Cloudflare.",
    ).map(({ capability }) => capability),
    [
      "infrastructure.digitalocean.read",
      "infrastructure.cloudflare.read",
    ],
  );
});
