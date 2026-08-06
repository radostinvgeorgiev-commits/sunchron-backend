import assert from "node:assert/strict";
import test from "node:test";

import {
  checkSupabaseStatus,
  SupabaseServiceError,
} from "../src/services/supabaseService.js";
import { TESTER_AUTH_BOOTSTRAP } from "../src/config/testerAuthBootstrap.js";

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

test("uses the public bootstrap when App Platform exposes encrypted placeholders", async () => {
  const result = await checkSupabaseStatus({
    env: {
      SUPABASE_URL: "EV[1:encrypted-placeholder]",
      SUPABASE_PUBLISHABLE_KEY: "EV[1:encrypted-placeholder]",
    },
    fetchImpl: async (url, options) => {
      assert.equal(
        url,
        `${TESTER_AUTH_BOOTSTRAP.projectUrl}/auth/v1/settings`,
      );
      assert.equal(
        options.headers.apikey,
        TESTER_AUTH_BOOTSTRAP.publishableKey,
      );
      return new Response("{}", { status: 200 });
    },
  });

  assert.equal(result.status, "healthy");
});

test("uses the public bootstrap when optional runtime values are omitted", async () => {
  const result = await checkSupabaseStatus({
    env: {},
    fetchImpl: async (url, options) => {
      assert.equal(
        url,
        `${TESTER_AUTH_BOOTSTRAP.projectUrl}/auth/v1/settings`,
      );
      assert.equal(
        options.headers.apikey,
        TESTER_AUTH_BOOTSTRAP.publishableKey,
      );
      return new Response("{}", { status: 200 });
    },
  });

  assert.equal(result.status, "healthy");
});

test("does not hide an ordinary invalid runtime URL", async () => {
  await assert.rejects(
    () =>
      checkSupabaseStatus({
        env: {
          SUPABASE_URL: "not-a-url",
          SUPABASE_PUBLISHABLE_KEY: TESTER_AUTH_BOOTSTRAP.publishableKey,
        },
      }),
    (error) =>
      error instanceof SupabaseServiceError &&
      error.code === "SUPABASE_INVALID_URL",
  );
});

test("does not hide an insecure runtime URL", async () => {
  await assert.rejects(
    () =>
      checkSupabaseStatus({
        env: {
          SUPABASE_URL: "http://project.supabase.co",
          SUPABASE_PUBLISHABLE_KEY: TESTER_AUTH_BOOTSTRAP.publishableKey,
        },
      }),
    (error) =>
      error instanceof SupabaseServiceError &&
      error.code === "SUPABASE_INSECURE_URL",
  );
});

test("does not replace an ordinary invalid runtime key", async () => {
  let fetchCalled = false;
  await assert.rejects(
    () =>
      checkSupabaseStatus({
        env: {
          SUPABASE_URL: "https://project.supabase.co",
          SUPABASE_PUBLISHABLE_KEY: "not-a-publishable-key",
        },
        fetchImpl: async () => {
          fetchCalled = true;
          return new Response("{}", { status: 200 });
        },
      }),
    (error) =>
      error instanceof SupabaseServiceError &&
      error.code === "SUPABASE_NOT_CONFIGURED",
  );
  assert.equal(fetchCalled, false);
});

test("prefers a valid runtime connection over the public bootstrap", async () => {
  const result = await checkSupabaseStatus({
    env: {
      SUPABASE_URL: "https://runtime-project.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "sb_publishable_runtime_key",
    },
    fetchImpl: async (url, options) => {
      assert.equal(
        url,
        "https://runtime-project.supabase.co/auth/v1/settings",
      );
      assert.equal(options.headers.apikey, "sb_publishable_runtime_key");
      return new Response("{}", { status: 200 });
    },
  });

  assert.equal(result.status, "healthy");
});

test("resolves partial explicit overrides independently", async () => {
  const explicitUrlResult = await checkSupabaseStatus({
    projectUrl: "https://explicit-project.supabase.co",
    env: {
      SUPABASE_URL: "not-a-url",
      SUPABASE_PUBLISHABLE_KEY: "sb_publishable_runtime_key",
    },
    fetchImpl: async (url, options) => {
      assert.equal(
        url,
        "https://explicit-project.supabase.co/auth/v1/settings",
      );
      assert.equal(options.headers.apikey, "sb_publishable_runtime_key");
      return new Response("{}", { status: 200 });
    },
  });
  const explicitKeyResult = await checkSupabaseStatus({
    publishableKey: "explicit-test-key",
    env: {
      SUPABASE_URL: "https://runtime-project.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "not-a-publishable-key",
    },
    fetchImpl: async (url, options) => {
      assert.equal(
        url,
        "https://runtime-project.supabase.co/auth/v1/settings",
      );
      assert.equal(options.headers.apikey, "explicit-test-key");
      return new Response("{}", { status: 200 });
    },
  });

  assert.equal(explicitUrlResult.status, "healthy");
  assert.equal(explicitKeyResult.status, "healthy");
});

test("keeps an explicitly supplied invalid project URL fail-closed", async () => {
  await assert.rejects(
    () =>
      checkSupabaseStatus({
        projectUrl: "EV[1:encrypted-placeholder]",
        publishableKey: "test-key",
      }),
    (error) =>
      error instanceof SupabaseServiceError &&
      error.code === "SUPABASE_INVALID_URL",
  );
});

test("keeps an explicitly supplied placeholder key fail-closed", async () => {
  let fetchCalled = false;
  await assert.rejects(
    () =>
      checkSupabaseStatus({
        projectUrl: "https://project.supabase.co",
        publishableKey: "EV[1:encrypted-placeholder]",
        fetchImpl: async () => {
          fetchCalled = true;
          return new Response("{}", { status: 200 });
        },
      }),
    (error) =>
      error instanceof SupabaseServiceError &&
      error.code === "SUPABASE_NOT_CONFIGURED" &&
      !error.message.includes("encrypted-placeholder"),
  );
  assert.equal(fetchCalled, false);
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
