import {
  resolveFirestoreDatabaseId,
  resolveFirestoreProjectId,
} from "../config/memoryBackend.js";

const FIRESTORE_API_ORIGIN = "https://firestore.googleapis.com";
const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_COMMIT_WRITES = 500;
const FIRESTORE_FILTER_OPERATORS = new Set([
  "EQUAL",
  "LESS_THAN",
  "LESS_THAN_OR_EQUAL",
  "GREATER_THAN",
  "GREATER_THAN_OR_EQUAL",
]);

function configurationError(message, code = "FIRESTORE_NOT_CONFIGURED") {
  const error = new Error(message);
  error.code = code;
  error.status = 503;
  return error;
}

function cleanIdentifier(value, label, pattern) {
  const clean = String(value || "").trim();
  if (!clean || !pattern.test(clean)) {
    throw configurationError(`Невалиден ${label}.`);
  }
  return clean;
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function encodeFirestoreValue(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === "boolean") return { booleanValue: value };
  if (Number.isInteger(value)) return { integerValue: String(value) };
  if (typeof value === "number") return { doubleValue: value };
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(encodeFirestoreValue) } };
  }
  if (typeof value === "object") {
    return { mapValue: { fields: encodeFirestoreFields(value) } };
  }
  return { stringValue: String(value) };
}

export function encodeFirestoreFields(document) {
  return Object.fromEntries(
    Object.entries(document).map(([key, value]) => [
      key,
      encodeFirestoreValue(value),
    ]),
  );
}

export function decodeFirestoreValue(value = {}) {
  if (Object.hasOwn(value, "stringValue")) return value.stringValue;
  if (Object.hasOwn(value, "booleanValue")) return value.booleanValue;
  if (Object.hasOwn(value, "integerValue")) {
    return Number.parseInt(value.integerValue, 10);
  }
  if (Object.hasOwn(value, "doubleValue")) return value.doubleValue;
  if (Object.hasOwn(value, "nullValue")) return null;
  if (value.arrayValue) {
    return (value.arrayValue.values || []).map(decodeFirestoreValue);
  }
  if (value.mapValue) {
    return decodeFirestoreFields(value.mapValue.fields || {});
  }
  return null;
}

export function decodeFirestoreFields(fields = {}) {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      decodeFirestoreValue(value),
    ]),
  );
}

function documentIdFromName(name) {
  return decodeURIComponent(
    String(name || "")
      .split("/")
      .at(-1) || "",
  );
}

function documentResult(document, { includeMetadata = false } = {}) {
  const result = {
    id: documentIdFromName(document.name),
    data: decodeFirestoreFields(document.fields),
  };
  if (!includeMetadata) return result;
  return {
    ...result,
    createTime: document.createTime || null,
    updateTime: document.updateTime || null,
  };
}

function firestoreError(response, fallbackCode, upstreamErrorStatus = null) {
  const error = new Error(
    `Firestore заявката е неуспешна (${response.status}).`,
  );
  error.code = fallbackCode;
  error.status = 503;
  error.upstreamStatus = response.status;
  error.upstreamErrorStatus = upstreamErrorStatus;
  return error;
}

function firestoreQueryError(payload = {}) {
  const error = new Error("Firestore заявката е неуспешна.");
  error.code = "FIRESTORE_UNAVAILABLE";
  error.status = 503;
  error.upstreamStatus = Number(payload.code) || null;
  error.upstreamErrorStatus = String(payload.status || "").trim() || null;
  return error;
}

export function createFirestoreDocumentStore({
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw configurationError("Липсва HTTP клиент за Firestore.");
  }

  const projectId = cleanIdentifier(
    resolveFirestoreProjectId(env),
    "Google Cloud project ID",
    /^[a-z][a-z0-9-]{4,61}[a-z0-9]$/u,
  );
  const databaseId = cleanIdentifier(
    resolveFirestoreDatabaseId(env),
    "Firestore database ID",
    /^(?:\(default\)|[a-z][a-z0-9-]{2,61}[a-z0-9])$/u,
  );
  const timeoutMs = parsePositiveInteger(
    env.FIRESTORE_REQUEST_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
  );
  const databasePath = `projects/${projectId}/databases/${databaseId}`;
  const documentsUrl = `${FIRESTORE_API_ORIGIN}/v1/${databasePath}/documents`;
  let cachedToken = null;

  async function loadAccessToken({ force = false } = {}) {
    if (!force && cachedToken && cachedToken.expiresAt > now() + 60_000) {
      return cachedToken.value;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(METADATA_TOKEN_URL, {
        headers: { "Metadata-Flavor": "Google" },
        signal: controller.signal,
      });
    } catch (cause) {
      const error = configurationError(
        "Cloud Run service identity не е достъпна.",
        "FIRESTORE_CREDENTIALS_UNAVAILABLE",
      );
      error.cause = cause;
      throw error;
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      throw firestoreError(response, "FIRESTORE_CREDENTIALS_UNAVAILABLE");
    }
    const payload = await response.json();
    if (!payload?.access_token) {
      throw configurationError(
        "Cloud Run service identity не върна access token.",
        "FIRESTORE_CREDENTIALS_UNAVAILABLE",
      );
    }
    cachedToken = {
      value: payload.access_token,
      expiresAt: now() + Math.max(1, Number(payload.expires_in) || 300) * 1000,
    };
    return cachedToken.value;
  }

  async function request(url, { method = "GET", body, allow404 = false } = {}) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await loadAccessToken({ force: attempt > 0 });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await fetchImpl(url, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: controller.signal,
        });
      } catch (cause) {
        const error = configurationError(
          "Firestore не отговори навреме.",
          "FIRESTORE_UNAVAILABLE",
        );
        error.cause = cause;
        throw error;
      } finally {
        clearTimeout(timer);
      }
      if (response.status === 401 && attempt === 0) {
        cachedToken = null;
        continue;
      }
      if (allow404 && response.status === 404) return null;
      if (!response.ok) {
        let upstreamErrorStatus = null;
        try {
          const payload = await response.json();
          upstreamErrorStatus =
            String(payload?.error?.status || "").trim() || null;
        } catch {
          // Error bodies are intentionally not retained or exposed.
        }
        throw firestoreError(
          response,
          "FIRESTORE_UNAVAILABLE",
          upstreamErrorStatus,
        );
      }
      if (response.status === 204) return null;
      return response.json();
    }
    throw configurationError(
      "Firestore authentication failed.",
      "FIRESTORE_CREDENTIALS_UNAVAILABLE",
    );
  }

  function cleanCollection(value) {
    return cleanIdentifier(
      value,
      "Firestore collection",
      /^[A-Za-z0-9_-]{1,120}$/u,
    );
  }

  function cleanDocumentId(id) {
    return cleanIdentifier(id, "Firestore document ID", /^[^/]{1,500}$/u);
  }

  function documentName(collection, id) {
    return `${databasePath}/documents/${cleanCollection(collection)}/${cleanDocumentId(id)}`;
  }

  function documentUrl(collection, id) {
    return `${FIRESTORE_API_ORIGIN}/v1/${databasePath}/documents/${cleanCollection(collection)}/${encodeURIComponent(cleanDocumentId(id))}`;
  }

  function updateWrite(collection, id, data, precondition = null) {
    return {
      update: {
        name: documentName(collection, id),
        fields: encodeFirestoreFields(data),
      },
      ...(precondition ? { currentDocument: precondition } : {}),
    };
  }

  function writePrecondition(options = {}, { deleteOperation = false } = {}) {
    const updateTime = String(options.updateTime || "").trim();
    if (updateTime) {
      const parsed = Date.parse(updateTime);
      if (!Number.isFinite(parsed)) {
        throw configurationError(
          "Невалиден Firestore updateTime precondition.",
          "FIRESTORE_INVALID_PRECONDITION",
        );
      }
      return { updateTime };
    }
    if (options.createOnly) return { exists: false };
    if (deleteOperation && options.mustExist) return { exists: true };
    return null;
  }

  function deleteWrite(collection, id, precondition = null) {
    return {
      delete: documentName(collection, id),
      ...(precondition ? { currentDocument: precondition } : {}),
    };
  }

  async function commit(writes) {
    if (!writes.length) return { writeResults: [] };
    if (writes.length > MAX_COMMIT_WRITES) {
      throw configurationError(
        "Firestore commit надвишава безопасния лимит.",
        "FIRESTORE_WRITE_LIMIT_EXCEEDED",
      );
    }
    return request(`${documentsUrl}:commit`, {
      method: "POST",
      body: { writes },
    });
  }

  return Object.freeze({
    backend: "firestore",
    projectId,
    databaseId,
    async query(
      collection,
      { filters = [], limit = 200, orderBy, includeMetadata = false } = {},
    ) {
      const safeLimit = Math.min(Math.max(Number(limit) || 1, 1), 1_000);
      if (!Array.isArray(filters) || filters.length < 1) {
        throw configurationError(
          "Firestore query изисква поне един точен филтър.",
          "FIRESTORE_INVALID_QUERY",
        );
      }
      const fieldFilters = filters.map((filter) => {
        const operator = String(filter.op || "EQUAL").toUpperCase();
        if (!FIRESTORE_FILTER_OPERATORS.has(operator)) {
          throw configurationError(
            "Неподдържан Firestore query operator.",
            "FIRESTORE_INVALID_QUERY",
          );
        }
        return {
          fieldFilter: {
            field: { fieldPath: String(filter.field) },
            op: operator,
            value: encodeFirestoreValue(filter.value),
          },
        };
      });
      const orderField = String(orderBy?.field || "").trim();
      const direction =
        String(orderBy?.direction || "ASCENDING").toUpperCase() === "DESCENDING"
          ? "DESCENDING"
          : "ASCENDING";
      const result = await request(`${documentsUrl}:runQuery`, {
        method: "POST",
        body: {
          structuredQuery: {
            from: [{ collectionId: cleanCollection(collection) }],
            where:
              fieldFilters.length === 1
                ? fieldFilters[0]
                : {
                    compositeFilter: {
                      op: "AND",
                      filters: fieldFilters,
                    },
                  },
            ...(orderField
              ? {
                  orderBy: [
                    {
                      field: { fieldPath: orderField },
                      direction,
                    },
                  ],
                }
              : {}),
            limit: safeLimit,
          },
        },
      });
      const embeddedError = Array.isArray(result)
        ? result.find((item) => item?.error)?.error
        : null;
      if (embeddedError) throw firestoreQueryError(embeddedError);

      return (Array.isArray(result) ? result : [])
        .map((item) => item?.document)
        .filter(Boolean)
        .map((document) => documentResult(document, { includeMetadata }));
    },
    queryEqual(collection, field, value, limit = 200, options = {}) {
      return this.query(collection, {
        filters: [{ field, value }],
        limit,
        orderBy: options.orderBy,
        includeMetadata: options.includeMetadata,
      });
    },
    async get(collection, id, options = {}) {
      const result = await request(documentUrl(collection, id), {
        allow404: true,
      });
      if (!result) return null;
      return documentResult(result, options);
    },
    set(collection, id, data, options = {}) {
      const precondition = writePrecondition(options);
      return commit([updateWrite(collection, id, data, precondition)]);
    },
    delete(collection, id, options = {}) {
      const precondition = writePrecondition(options, {
        deleteOperation: true,
      });
      return commit([deleteWrite(collection, id, precondition)]);
    },
    commitOperations(operations) {
      return commit(
        operations.map((operation) => {
          if (operation.type === "set") {
            return updateWrite(
              operation.collection,
              operation.id,
              operation.data,
              writePrecondition(operation),
            );
          }
          if (operation.type === "delete") {
            return deleteWrite(
              operation.collection,
              operation.id,
              writePrecondition(operation, { deleteOperation: true }),
            );
          }
          throw configurationError(
            "Непозната Firestore write операция.",
            "FIRESTORE_INVALID_WRITE",
          );
        }),
      );
    },
  });
}
