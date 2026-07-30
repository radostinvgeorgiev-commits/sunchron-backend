import assert from "node:assert/strict";
import test from "node:test";

import {
  getDigitalOceanAccountAudit,
  getDigitalOceanAppStatus,
  formatDigitalOceanAudit,
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
  assert.ok(
    calls.every(
      (call) => !call.options.method || call.options.method === "GET",
    ),
  );
  assert.doesNotMatch(JSON.stringify(status), /secret/u);
});

test("DigitalOcean full audit reads account resources without writes or secrets", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const path = new URL(String(url)).pathname;
    calls.push({ path, options });
    if (path === "/v2/account") {
      return Response.json({
        account: {
          status: "active",
          email_verified: true,
          droplet_limit: 10,
          volume_limit: 10,
        },
      });
    }
    if (path === "/v2/apps") {
      return Response.json({
        apps: [
          {
            id: "app-1",
            spec: { name: "sunchron-backend" },
            active_deployment: { phase: "ACTIVE" },
          },
        ],
      });
    }
    if (path === "/v2/droplets") {
      return Response.json({
        droplets: [
          {
            id: 1,
            name: "api",
            status: "active",
            features: [],
            size_slug: "s-1vcpu-1gb",
            region: { slug: "fra1" },
          },
        ],
      });
    }
    if (path === "/v2/databases") {
      return Response.json({
        databases: [
          {
            id: "db-1",
            name: "memory",
            status: "online",
            engine: "opensearch",
            region: "fra1",
          },
        ],
      });
    }
    if (path === "/v2/volumes") {
      return Response.json({
        volumes: [
          {
            id: "vol-1",
            name: "data",
            size_gigabytes: 10,
            droplet_ids: [],
            region: { slug: "fra1" },
          },
        ],
      });
    }
    if (path === "/v2/firewalls") {
      return Response.json({ firewalls: [] });
    }
    if (path === "/v2/actions") {
      return Response.json({
        actions: [{ id: 1, status: "errored", type: "deploy" }],
      });
    }
    if (path === "/v2/customers/my/balance") {
      return Response.json({
        month_to_date_usage: "12.34",
        account_balance: "0.00",
        currency: "EUR",
      });
    }
    if (path === "/v2/registry") {
      return Response.json({ registry: null });
    }
    const keyByPath = {
      "/v2/snapshots": "snapshots",
      "/v2/vpcs": "vpcs",
      "/v2/domains": "domains",
      "/v2/load_balancers": "load_balancers",
      "/v2/reserved_ips": "reserved_ips",
      "/v2/kubernetes/clusters": "kubernetes",
      "/v2/certificates": "certificates",
      "/v2/cdn/endpoints": "endpoints",
      "/v2/functions/namespaces": "namespaces",
      "/v2/images": "images",
      "/v2/account/keys": "ssh_keys",
      "/v2/tags": "tags",
      "/v2/uptime/checks": "checks",
      "/v2/projects": "projects",
    };
    return Response.json({ [keyByPath[path]]: [] });
  };
  const audit = await getDigitalOceanAccountAudit({
    env: { DIGITALOCEAN_API_TOKEN: "secret" },
    fetchImpl,
  });
  assert.equal(audit.account.status, "active");
  assert.equal(audit.apps.length, 1);
  assert.equal(audit.droplets.length, 1);
  assert.equal(audit.databases[0].engine, "opensearch");
  assert.match(formatDigitalOceanAudit(audit), /пълен одит/u);
  assert.match(
    formatDigitalOceanAudit(audit),
    /без включени автоматични backups/u,
  );
  assert.equal(audit.unavailable.length, 0);
  assert.equal(calls.length, 23);
  assert.ok(calls.every((call) => call.options.method === "GET"));
  assert.doesNotMatch(JSON.stringify(audit), /secret/u);
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
  assert.ok(
    calls.every(
      (call) => !call.options.method || call.options.method === "GET",
    ),
  );
  assert.doesNotMatch(JSON.stringify(status), /secret/u);
});

test("chat routes infrastructure status requests to the bridges", () => {
  assert.deepEqual(
    detectCapabilityRequests(
      "Провери статуса на DigitalOcean и покажи DNS записите в Cloudflare.",
    ).map(({ capability }) => capability),
    ["infrastructure.digitalocean.read", "infrastructure.cloudflare.read"],
  );
  assert.deepEqual(
    detectCapabilityRequests(
      "Направи пълен одит на целия DigitalOcean акаунт, ресурсите, разходите и сигурността.",
    ).map(({ capability }) => capability),
    ["infrastructure.digitalocean.read"],
  );
});
