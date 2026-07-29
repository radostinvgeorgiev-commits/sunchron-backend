import assert from "node:assert/strict";
import test from "node:test";

import {
  checkSupabaseStatus,
  SupabaseServiceError,
} from "../src/services/supabaseService.js";

test("проверява Supabase Data API без да връща ключа", async () => {
  const result = await checkSupabaseStatus({
    projectUrl: "https://project.supabase.co",
    publishableKey: "test-publishable-key",
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://project.supabase.co/rest/v1/");
      assert.equal(options.headers.apikey, "test-publishable-key");
      assert.equal(options.headers.Authorization, undefined);
      return new Response("{}", { status: 200 });
    },
  });

  assert.equal(result.status, "healthy");
  assert.equal(result.service, "Supabase Data API");
  assert.equal("publishableKey" in result, false);
});

test("отказва работа без пълна Supabase конфигурация", async () => {
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

test("изисква защитена Supabase връзка", async () => {
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
