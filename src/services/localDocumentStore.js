import {
  decodeFirestoreFields,
  encodeFirestoreFields,
} from "./firestoreDocumentStore.js";

// An in-process stand-in for the Firestore document store. It is used only
// by the "local" persistence backend (development and tests without a Google
// Cloud project) and is never chosen in production. Data lives in the running
// process and is lost on restart. It follows the Firestore store contract:
// same methods, same precondition errors, values round-tripped through the
// Firestore encoding.

const MAX_COMMIT_WRITES = 500;

function preconditionError(upstreamStatus, upstreamErrorStatus) {
  const error = new Error(
    `Firestore заявката е неуспешна (${upstreamStatus}).`,
  );
  error.code = "FIRESTORE_UNAVAILABLE";
  error.status = 503;
  error.upstreamStatus = upstreamStatus;
  error.upstreamErrorStatus = upstreamErrorStatus;
  return error;
}

function invalidQuery(message) {
  const error = new Error(message);
  error.code = "FIRESTORE_INVALID_QUERY";
  error.status = 503;
  return error;
}

function compare(left, right) {
  if (left === right) return 0;
  if (left === undefined || left === null) return -1;
  if (right === undefined || right === null) return 1;
  return left < right ? -1 : 1;
}

const OPERATORS = Object.freeze({
  EQUAL: (value, expected) => value === expected,
  LESS_THAN: (value, expected) =>
    value !== undefined && value !== null && compare(value, expected) < 0,
  LESS_THAN_OR_EQUAL: (value, expected) =>
    value !== undefined && value !== null && compare(value, expected) <= 0,
  GREATER_THAN: (value, expected) =>
    value !== undefined && value !== null && compare(value, expected) > 0,
  GREATER_THAN_OR_EQUAL: (value, expected) =>
    value !== undefined && value !== null && compare(value, expected) >= 0,
});

export function createLocalDocumentStore() {
  const collections = new Map();
  let clock = 0;

  const records = (collection) => {
    const name = String(collection);
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name);
  };
  const nextTime = () => {
    clock += 1;
    return new Date(Date.UTC(2000, 0, 1) + clock).toISOString();
  };
  const result = (id, record, includeMetadata) => ({
    id,
    data: decodeFirestoreFields(record.fields),
    ...(includeMetadata
      ? { createTime: record.createTime, updateTime: record.updateTime }
      : {}),
  });
  const verify = (record, options = {}, { deleteOperation = false } = {}) => {
    const updateTime = String(options.updateTime || "").trim();
    if (updateTime) {
      if (!record || record.updateTime !== updateTime) {
        throw preconditionError(400, "FAILED_PRECONDITION");
      }
      return;
    }
    if (options.createOnly && record) {
      throw preconditionError(409, "ALREADY_EXISTS");
    }
    if (deleteOperation && options.mustExist && !record) {
      throw preconditionError(404, "NOT_FOUND");
    }
  };
  const apply = (operation) => {
    const collection = records(operation.collection);
    if (operation.type === "delete") {
      collection.delete(String(operation.id));
      return;
    }
    const existing = collection.get(String(operation.id));
    const time = nextTime();
    collection.set(String(operation.id), {
      fields: encodeFirestoreFields(operation.data),
      createTime: existing?.createTime || time,
      sequence: existing?.sequence ?? clock,
      updateTime: time,
    });
  };

  return Object.freeze({
    backend: "local",
    clearForTests() {
      collections.clear();
    },
    async query(
      collection,
      { filters = [], limit = 200, orderBy, includeMetadata = false } = {},
    ) {
      if (!Array.isArray(filters) || filters.length < 1) {
        throw invalidQuery("Firestore query изисква поне един точен филтър.");
      }
      const checks = filters.map((filter) => {
        const operator = String(filter.op || "EQUAL").toUpperCase();
        const check = OPERATORS[operator];
        if (!check) throw invalidQuery("Неподдържан Firestore query operator.");
        return { field: String(filter.field), value: filter.value, check };
      });
      const safeLimit = Math.min(Math.max(Number(limit) || 1, 1), 1_000);
      let rows = [...records(collection)]
        .map(([id, record]) => ({
          id,
          record,
          data: decodeFirestoreFields(record.fields),
        }))
        .filter(({ data }) =>
          checks.every(({ field, value, check }) => check(data[field], value)),
        );
      const orderField = String(orderBy?.field || "").trim();
      if (orderField) {
        const direction =
          String(orderBy?.direction || "ASCENDING").toUpperCase() ===
          "DESCENDING"
            ? -1
            : 1;
        rows = rows
          .filter(({ data }) => data[orderField] !== undefined)
          .sort(
            (left, right) =>
              direction *
              (compare(left.data[orderField], right.data[orderField]) ||
                // Equal values keep the order of creation, so "newest
                // first" stays deterministic within one millisecond.
                left.record.sequence - right.record.sequence),
          );
      }
      return rows
        .slice(0, safeLimit)
        .map(({ id, record }) => result(id, record, includeMetadata));
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
      const record = records(collection).get(String(id));
      return record
        ? result(String(id), record, options.includeMetadata)
        : null;
    },
    async set(collection, id, data, options = {}) {
      verify(records(collection).get(String(id)), options);
      apply({ type: "set", collection, id, data });
      return { writeResults: [{}] };
    },
    async delete(collection, id, options = {}) {
      verify(records(collection).get(String(id)), options, {
        deleteOperation: true,
      });
      apply({ type: "delete", collection, id });
      return { writeResults: [{}] };
    },
    async increment(collection, id, fields = {}) {
      const record = records(collection).get(String(id));
      const data = record ? decodeFirestoreFields(record.fields) : {};
      for (const [field, amount] of Object.entries(fields)) {
        if (/^[a-z][a-z0-9_]{0,39}$/u.test(field) && Number.isInteger(amount)) {
          data[field] = (Number(data[field]) || 0) + amount;
        }
      }
      apply({ type: "set", collection, id, data });
      return { writeResults: [{}] };
    },
    async commitOperations(operations) {
      if (operations.length > MAX_COMMIT_WRITES) {
        const error = new Error("Firestore commit надвишава безопасния лимит.");
        error.code = "FIRESTORE_WRITE_LIMIT_EXCEEDED";
        error.status = 503;
        throw error;
      }
      for (const operation of operations) {
        if (operation.type !== "set" && operation.type !== "delete") {
          const error = new Error("Непозната Firestore write операция.");
          error.code = "FIRESTORE_INVALID_WRITE";
          error.status = 503;
          throw error;
        }
        verify(
          records(operation.collection).get(String(operation.id)),
          operation,
          {
            deleteOperation: operation.type === "delete",
          },
        );
      }
      for (const operation of operations) apply(operation);
      return { writeResults: operations.map(() => ({})) };
    },
  });
}

let sharedLocalStore = null;

export function getLocalDocumentStore() {
  if (!sharedLocalStore) sharedLocalStore = createLocalDocumentStore();
  return sharedLocalStore;
}

export function resetLocalDocumentStoreForTests() {
  sharedLocalStore?.clearForTests();
}
