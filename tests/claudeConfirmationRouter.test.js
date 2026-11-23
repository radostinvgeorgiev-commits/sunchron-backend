import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { requirePrimaryOwner } from "../src/middleware/ownerAuth.js";
import { createClaudeConfirmationRouter } from "../src/routes/claudeConfirmationRouter.js";

test("owner inspects and confirms a Claude plan once; members and cross-origin requests cannot", async () => {
  const id = "11b0a52e-9f3b-41fd-a926-d8810e82a1c8";
  let pending = true;
  let executions = 0;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.owner = { role: req.get("x-test-role"), memoryOwnerId: "owner" };
    next();
  });
  app.use(
    requirePrimaryOwner,
    createClaudeConfirmationRouter({
      validate: async (actualId, sessionId) => {
        assert.equal(actualId, id);
        assert.equal(sessionId, "claude:owner");
        if (!pending) throw new Error("used");
        return {
          action: "github.write:update_file",
          resource: { commitSha: "abc" },
          params: {},
          expiresAt: 1,
        };
      },
      getGitHubSession: async () => ({}),
      confirmGitHub: async () => {
        pending = false;
        executions++;
      },
    }),
  );
  const post = (path, role = "owner", origin = "https://cloudaicore.com") =>
    request(app)
      .post(path)
      .set("Origin", origin)
      .set("x-test-role", role)
      .send({ confirmationId: id });
  await post("/inspect", "member").expect(403);
  await post("/confirm", "owner", "https://evil.example").expect(403);
  const preview = await post("/inspect").expect(200);
  assert.equal(preview.body.resource.commitSha, "abc");
  assert.equal(executions, 0);
  await post("/confirm").expect(200);
  await post("/confirm").expect(400);
  assert.equal(executions, 1);
});
