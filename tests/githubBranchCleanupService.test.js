import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMergedBranchCleanupPlan,
  executeMergedBranchCleanup,
  isMergedBranchCleanupPlanRequest,
  prepareMergedBranchCleanup,
} from "../src/services/githubBranchCleanupService.js";

const repository = "radostinvgeorgiev-commits/sunchron-backend";

function response(data, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(data), { status });
}

function fixtureFetch(deleted = []) {
  return async (url, options = {}) => {
    const parsed = new URL(url);
    const path = parsed.pathname;
    if (options.method === "DELETE") {
      deleted.push(decodeURIComponent(path.split("/").at(-1)));
      return response(null, 204);
    }
    if (path === `/repos/${repository}`) {
      return response({ default_branch: "main" });
    }
    if (path.endsWith("/branches")) {
      return response([
        { name: "main", protected: true },
        { name: "merged-safe", protected: false },
        { name: "merged-open", protected: false },
        { name: "protected-merged", protected: true },
        { name: "never-merged", protected: false },
      ]);
    }
    const state = parsed.searchParams.get("state");
    if (path.endsWith("/pulls") && state === "open") {
      return response([{ head: { ref: "merged-open" } }]);
    }
    if (path.endsWith("/pulls") && state === "closed") {
      return response([
        {
          merged_at: "2026-07-30T00:00:00Z",
          head: { ref: "merged-safe", repo: { full_name: repository } },
        },
        {
          merged_at: "2026-07-30T00:00:00Z",
          head: { ref: "merged-open", repo: { full_name: repository } },
        },
        {
          merged_at: "2026-07-30T00:00:00Z",
          head: { ref: "protected-merged", repo: { full_name: repository } },
        },
      ]);
    }
    throw new Error(`Unexpected request: ${url}`);
  };
}

test("cleanup plan includes only safe merged branches", async () => {
  const plan = await buildMergedBranchCleanupPlan({
    repository,
    fetchImpl: fixtureFetch(),
    getSession: async () => ({ accessToken: "owner-token" }),
  });
  assert.deepEqual(plan.branchNames, ["merged-safe"]);
  assert.equal(plan.count, 1);
  assert.equal(plan.defaultBranch, "main");
  assert.equal(plan.fingerprint.length, 64);
});

test("cleanup revalidates the exact plan before deleting", async () => {
  const deleted = [];
  const fetchImpl = fixtureFetch(deleted);
  const getSession = async () => ({ accessToken: "owner-token" });
  const plan = await buildMergedBranchCleanupPlan({
    repository,
    fetchImpl,
    getSession,
  });
  const result = await executeMergedBranchCleanup({
    repository,
    branchNames: plan.branchNames,
    fingerprint: plan.fingerprint,
    fetchImpl,
    getSession,
  });
  assert.deepEqual(deleted, ["merged-safe"]);
  assert.equal(result.count, 1);
});

test("cleanup refuses a changed or forged branch list", async () => {
  await assert.rejects(
    executeMergedBranchCleanup({
      repository,
      branchNames: ["main"],
      fingerprint: "invalid",
      fetchImpl: fixtureFetch(),
      getSession: async () => ({ accessToken: "owner-token" }),
    }),
    (error) => error.code === "BRANCH_CLEANUP_PLAN_CHANGED",
  );
});

test("recognizes a safe merged-branch cleanup plan request", () => {
  assert.equal(
    isMergedBranchCleanupPlanRequest(
      "Подготви безопасен списък за изтриване само на GitHub клоновете от вече слети PR-и. Не изтривай нищо.",
    ),
    true,
  );
  assert.equal(
    isMergedBranchCleanupPlanRequest("Покажи последния GitHub commit."),
    false,
  );
});

test("prepares the exact cleanup plan without deleting branches", async () => {
  const confirmations = [];
  const output = await prepareMergedBranchCleanup({
    ownerId: "github:owner",
    buildPlan: async () => ({
      repository,
      defaultBranch: "main",
      branchNames: ["merged-safe"],
      count: 1,
      fingerprint: "fingerprint",
    }),
    createConfirmation: async (data) => {
      confirmations.push(data);
      return { ...data, id: "confirmation-1" };
    },
  });

  assert.match(output, /merged-safe/u);
  assert.match(output, /Нищо не е изтрито/u);
  assert.match(output, /confirmation-1/u);
  assert.equal(confirmations[0].sessionId, "github:owner");
  assert.deepEqual(confirmations[0].params.branchNames, ["merged-safe"]);
});
