import assert from "node:assert/strict";
import test from "node:test";

import {
  checkSupabaseStatus,
  SupabaseServiceError,
} from "../src/services/supabaseService.js";

test("checks Supabase API without returning its key", async () => {
  const result = await checkSupabaseStatus({
    projectUrl: "https://project.supabase.co",
    publishableKey: "test-publishable-key",
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://project.supabase.co/auth/v1/settings");
      assert.equal(options.headers.apikey, "test-publishable-key");
      assert.equal(options.headers.Accept, "application/json");
      assert.equal(options.headers.Authorization, undefined);
      return new Response("{}", { status: 200 });
    },
  });

  assert.equal(result.status, "healthy");
  assert.equal(result.service, "Supabase API");
  assert.equal("publishableKey" in result, false);
});

test("refuses to run without complete Supabase configuration", async () => {
  await assert.rejects(
    () =>
      checkSupabaseStatus({
        projectUrl: "https://project.supabase.co",
        publishableKey: "",
      }),
    (error) =>
      error instanceof SupabaseServiceError &&
      error.code === "SUPABASE_NOT_CONFIGURED",
  );
});

test("requires a protected Supabase connection", async () => {
  await assert.rejects(
    () =>
      checkSupabaseStatus({
        projectUrl: "http://project.supabase.co",
        publishableKey: "test-key",
      }),
    (error) =>
      error instanceof SupabaseServiceError &&
      error.code === "SUPABASE_INSECURE_URL",
  );
});

test("aborts a blocked Supabase upstream request", async () => {
  await assert.rejects(
    () =>
      checkSupabaseStatus({
        projectUrl: "https://project.supabase.co",
        publishableKey: "test-key",
        timeoutMs: 5,
        fetchImpl: async (_url, { signal }) =>
          new Promise((_, reject) => {
            signal.addEventListener("abort", () => {
              const error = new Error("blocked request");
              error.name = "AbortError";
              reject(error);
            });
          }),
      }),
    (error) =>
      error instanceof SupabaseServiceError &&
      error.code === "SUPABASE_TIMEOUT" &&
      !error.message.includes("blocked request"),
  );
});

test("does not expose an upstream Supabase response body", async () => {
  await assert.rejects(
    () =>
      checkSupabaseStatus({
        projectUrl: "https://project.supabase.co",
        publishableKey: "test-key",
        fetchImpl: async () =>
          new Response('{"secret":"must-not-leak"}', { status: 503 }),
      }),
    (error) =>
      error instanceof SupabaseServiceError &&
      error.code === "SUPABASE_UPSTREAM_ERROR" &&
      !error.message.includes("must-not-leak"),
  );
});
