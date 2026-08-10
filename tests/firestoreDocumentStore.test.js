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
