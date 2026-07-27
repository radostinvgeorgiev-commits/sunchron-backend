import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";

process.env.NODE_ENV = "test";

const { default: app } = await import("../server.js");

test("legacy confirmed-actions API is not publicly mounted", async () => {
  const discovery = await request(app).get("/confirmed-actions");
  assert.equal(discovery.status, 404);

  const directWrite = await request(app)
    .post("/confirmed-actions/request")
    .send({
      sessionId: "attacker-controlled-session",
      action: "github.write:create_file",
      resource: {
        repository: "radostinvgeorgiev-commits/sunchron-backend",
        branch: "main",
        path: "unsafe.txt",
      },
      params: { content: "must not execute" },
    });
  assert.equal(directWrite.status, 404);
});
