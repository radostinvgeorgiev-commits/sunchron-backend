import assert from "node:assert/strict";
import test from "node:test";

import {
  createFirestoreDocumentStore,
  decodeFirestoreFields,
  encodeFirestoreFields,
} from "../src/services/firestoreDocumentStore.js";

const ENV = Object.freeze({
  GOOGLE_CLOUD_PROJECT: "handy-boulevard-479120-q9",
  FIRESTORE_DATABASE_ID: "(default)",
  FIRESTORE_REQUEST_TIMEOUT_MS: "1000",
});

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("Firestore field encoding round-trips the supported SYNCHRON values", () => {
  const value = {
    text: "памет",
    count: 7,
    ratio: 1.5,
    ready: true,
    empty: null,
    list: ["a", 2],
    nested: { ownerId: "owner-a" },
  };
  assert.deepEqual(decodeFirestoreFields(encodeFirestoreFields(value)), value);
});

test("Firestore queries use Cloud Run service identity and never a key file", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes("metadata.google.internal")) {
      return jsonResponse({ access_token: "runtime-token", expires_in: 3600 });
    }
    return jsonResponse([
      {
        document: {
          name: `${ENV.GOOGLE_CLOUD_PROJECT}/databases/(default)/documents/memory/doc-1`,
          fields: encodeFirestoreFields({ ownerId: "owner-a", fact: "син" }),
        },
      },
    ]);
  };
  const store = createFirestoreDocumentStore({ env: ENV, fetchImpl });

  const documents = await store.queryEqual("memory", "ownerId", "owner-a", 5);

  assert.deepEqual(documents, [
    { id: "doc-1", data: { ownerId: "owner-a", fact: "син" } },
  ]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.headers["Metadata-Flavor"], "Google");
  assert.equal(calls[1].options.headers.Authorization, "Bearer runtime-token");
  assert.match(calls[1].url, /documents:runQuery$/u);
  const requestBody = JSON.parse(calls[1].options.body);
  assert.equal(requestBody.structuredQuery.from[0].collectionId, "memory");
  assert.equal(
    requestBody.structuredQuery.where.fieldFilter.value.stringValue,
    "owner-a",
  );
});

test("Firestore retries once with a fresh metadata token after HTTP 401", async () => {
  let metadataCalls = 0;
  let apiCalls = 0;
  const fetchImpl = async (url) => {
    if (String(url).includes("metadata.google.internal")) {
      metadataCalls += 1;
      return jsonResponse({
        access_token: `runtime-token-${metadataCalls}`,
        expires_in: 3600,
      });
    }
    apiCalls += 1;
    return apiCalls === 1 ? jsonResponse({}, 401) : jsonResponse([]);
  };
  const store = createFirestoreDocumentStore({ env: ENV, fetchImpl });

  assert.deepEqual(
    await store.queryEqual("memory", "ownerId", "owner-a", 1),
    [],
  );
  assert.equal(metadataCalls, 2);
  assert.equal(apiCalls, 2);
});

test("Firestore builds bounded owner and session queries with explicit order", async () => {
  let queryBody;
  const fetchImpl = async (url, options = {}) => {
    if (String(url).includes("metadata.google.internal")) {
      return jsonResponse({ access_token: "runtime-token", expires_in: 3600 });
    }
    queryBody = JSON.parse(options.body);
    return jsonResponse([]);
  };
  const store = createFirestoreDocumentStore({ env: ENV, fetchImpl });

  await store.query("conversations", {
    filters: [
      { field: "ownerId", value: "owner-a" },
      { field: "sessionId", value: "session-a" },
    ],
    orderBy: { field: "createdAt", direction: "DESCENDING" },
    limit: 20,
  });

  const query = queryBody.structuredQuery;
  assert.equal(query.where.compositeFilter.op, "AND");
  assert.equal(query.where.compositeFilter.filters.length, 2);
  assert.deepEqual(query.orderBy, [
    { field: { fieldPath: "createdAt" }, direction: "DESCENDING" },
  ]);
  assert.equal(query.limit, 20);
});

test("Firestore commit is bounded and supports atomic set plus delete", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes("metadata.google.internal")) {
      return jsonResponse({ access_token: "runtime-token", expires_in: 3600 });
    }
    return jsonResponse({ writeResults: [{}, {}] });
  };
  const store = createFirestoreDocumentStore({ env: ENV, fetchImpl });

  await store.commitOperations([
    {
      type: "set",
      collection: "memory",
      id: "stable-id",
      data: { ownerId: "owner-a", fact: "зелено" },
    },
    { type: "delete", collection: "memory", id: "legacy-id" },
  ]);

  const commitCall = calls.find(({ url }) => url.endsWith("documents:commit"));
  const body = JSON.parse(commitCall.options.body);
  assert.equal(body.writes.length, 2);
  assert.match(body.writes[0].update.name, /\/memory\/stable-id$/u);
  assert.match(body.writes[1].delete, /\/memory\/legacy-id$/u);
});

test("Firestore exposes opt-in version metadata and applies range plus updateTime preconditions", async () => {
  const calls = [];
  const updateTime = "2026-08-10T10:11:12.123456Z";
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes("metadata.google.internal")) {
      return jsonResponse({ access_token: "runtime-token", expires_in: 3600 });
    }
    if (String(url).endsWith("documents:runQuery")) {
      return jsonResponse([
        {
          document: {
            name: `${ENV.GOOGLE_CLOUD_PROJECT}/databases/(default)/documents/replay/one`,
            fields: encodeFirestoreFields({ expiresAtEpoch: 100 }),
            createTime: "2026-08-10T10:00:00Z",
            updateTime,
          },
        },
      ]);
    }
    return jsonResponse({ writeResults: [{}] });
  };
  const store = createFirestoreDocumentStore({ env: ENV, fetchImpl });

  const [document] = await store.query("replay", {
    filters: [
      { field: "expiresAtEpoch", op: "LESS_THAN_OR_EQUAL", value: 100 },
    ],
    includeMetadata: true,
    limit: 1,
  });
  assert.equal(document.updateTime, updateTime);

  await store.set("replay", "one", { expiresAtEpoch: 200 }, { updateTime });
  const queryCall = calls.find(({ url }) => url.endsWith("documents:runQuery"));
  const queryBody = JSON.parse(queryCall.options.body);
  assert.equal(
    queryBody.structuredQuery.where.fieldFilter.op,
    "LESS_THAN_OR_EQUAL",
  );
  const commitCall = calls.find(({ url }) => url.endsWith("documents:commit"));
  const commitBody = JSON.parse(commitCall.options.body);
  assert.equal(commitBody.writes[0].currentDocument.updateTime, updateTime);
});

test("Firestore normalizes only the upstream status code without exposing its message", async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes("metadata.google.internal")) {
      return jsonResponse({ access_token: "runtime-token", expires_in: 3600 });
    }
    return jsonResponse(
      {
        error: {
          status: "FAILED_PRECONDITION",
          message: "private document detail",
        },
      },
      400,
    );
  };
  const store = createFirestoreDocumentStore({ env: ENV, fetchImpl });

  await assert.rejects(
    () => store.set("memory", "one", { value: true }),
    (error) => {
      assert.equal(error.upstreamErrorStatus, "FAILED_PRECONDITION");
      assert.doesNotMatch(error.message, /private document detail/u);
      return true;
    },
  );
});

test("Firestore failures do not expose upstream bodies or credentials", async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes("metadata.google.internal")) {
      return jsonResponse({ access_token: "do-not-log-me", expires_in: 3600 });
    }
    return jsonResponse({ error: "private upstream detail" }, 503);
  };
  const store = createFirestoreDocumentStore({ env: ENV, fetchImpl });

  await assert.rejects(
    () => store.get("memory", "doc-1"),
    (error) => {
      assert.equal(error.code, "FIRESTORE_UNAVAILABLE");
      assert.doesNotMatch(
        error.message,
        /private upstream detail|do-not-log-me/u,
      );
      return true;
    },
  );
});
