import { createHash, createHmac } from "node:crypto";

import { getOpenSearchClient } from "../config/opensearch.js";
import { resolveAuthBackend } from "../config/authBackend.js";
import { resolvePersistenceBackend } from "../config/memoryBackend.js";
import { createFirestoreTesterAccessStore } from "./firestoreTesterAccessStore.js";
import { logSafeError } from "../utils/safeLogging.js";

const DEFAULT_INDEX = "synchron-tester-access-v1";
const ACCESS_REQUEST_OPTIONS = Object.freeze({
  requestTimeout: 5_000,
  maxRetries: 0,
});
let firestoreStore = null;
let firestoreConfiguration = null;
let firestoreStoreOverride = null;

export function setFirestoreTesterAccessStoreForTests(store) {
  firestoreStoreOverride = store || null;
  firestoreStore = null;
  firestoreConfiguration = null;
}

export class TesterAccessError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = "TesterAccessError";
    this.status = status;
    this.code = code;
  }
}

function cleanUserId(user) {
  const userId = typeof user?.id === "string" ? user.id.trim() : "";
  if (!userId) {
    throw new TesterAccessError(
      "Auth доставчикът не върна валиден потребител.",
      502,
      "AUTH_INVALID_USER",
    );
  }
  return userId;
}

function authProvider(user, env = process.env) {
  return user?.authProvider || resolveAuthBackend(env) || "identity-platform";
}

function accessDocumentId(user, env = process.env) {
  const userId = cleanUserId(user);
  const provider = authProvider(user, env);
  return `${provider}:${userId}`;
}

function emailApprovalKey(env = process.env) {
  const secret = (
    env.USER_SESSION_ENCRYPTION_KEY ||
    env.GITHUB_SESSION_ENCRYPTION_KEY ||
    env.MCP_ACCESS_TOKEN ||
    env.SYNCHRON_TEST_INVITE_CODE ||
    ""
  ).trim();
  if (secret.length < 16) {
    throw new TesterAccessError(
      "Защитата на одобренията по имейл не е конфигурирана.",
      503,
      "TESTER_ACCESS_UNAVAILABLE",
    );
  }
  return createHash("sha256")
    .update("synchron-tester-email-approval-v1\0")
    .update(secret)
    .digest();
}

function getFirestoreStore(env = process.env) {
  if (firestoreStoreOverride) return firestoreStoreOverride;
  const configuration = [
    env.GOOGLE_CLOUD_PROJECT,
    env.GCLOUD_PROJECT,
    env.GCP_PROJECT_ID,
    env.FIRESTORE_DATABASE_ID,
    env.FIRESTORE_TESTER_ACCESS_COLLECTION,
  ].join("\0");
  if (!firestoreStore || firestoreConfiguration !== configuration) {
    firestoreStore = createFirestoreTesterAccessStore({ env });
    firestoreConfiguration = configuration;
  }
  return firestoreStore;
}

async function saveAccessDocument(id, body, { client, env, createOnly }) {
  const backend = resolvePersistenceBackend(env);
  if (!backend) {
    throw new TesterAccessError(
      "Проверката на одобрените тестови профили има невалидна storage конфигурация.",
      503,
      "TESTER_ACCESS_UNAVAILABLE",
    );
  }
  if (backend === "firestore") {
    await getFirestoreStore(env).set(id, body, { createOnly });
    return;
  }
  await requireClient(client).index(
    {
      index: accessIndex(env),
      id,
      body,
      refresh: true,
      ...(createOnly ? { op_type: "create" } : {}),
    },
    ACCESS_REQUEST_OPTIONS,
  );
}

async function loadAccessDocument(id, { client, env }) {
  const backend = resolvePersistenceBackend(env);
  if (!backend) {
    throw new TesterAccessError(
      "Проверката на одобрените тестови профили има невалидна storage конфигурация.",
      503,
      "TESTER_ACCESS_UNAVAILABLE",
    );
  }
  if (backend === "firestore") {
    return (await getFirestoreStore(env).get(id))?.data || null;
  }
  const response = await requireClient(client).get(
    { index: accessIndex(env), id },
    ACCESS_REQUEST_OPTIONS,
  );
  return response.body?._source ?? response._source;
}

function cleanEmailHash(value, env = process.env) {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!email) return "";
  return createHmac("sha256", emailApprovalKey(env))
    .update(email)
    .digest("hex");
}

function emailApprovalId(emailHash) {
  return `email:${emailHash}`;
}

function accessIndex(env = process.env) {
  const configured =
    typeof env.TESTER_ACCESS_INDEX === "string"
      ? env.TESTER_ACCESS_INDEX.trim()
      : "";
  return configured || DEFAULT_INDEX;
}

function requireClient(client = getOpenSearchClient()) {
  if (!client) {
    throw new TesterAccessError(
      "Проверката на одобрените тестови профили временно не е достъпна.",
      503,
      "TESTER_ACCESS_UNAVAILABLE",
    );
  }
  return client;
}

function statusCode(error) {
  return error?.statusCode || error?.meta?.statusCode || error?.status;
}

function isAccessDocumentConflict(error) {
  return (
    Number(statusCode(error)) === 409 ||
    [409, 412].includes(error?.upstreamStatus) ||
    ["ALREADY_EXISTS", "FAILED_PRECONDITION"].includes(
      error?.upstreamErrorStatus,
    )
  );
}

function isApprovedAccess(source, userId, provider) {
  return (
    source?.userId === userId &&
    source.status === "approved" &&
    (!source.authProvider || source.authProvider === provider)
  );
}

export async function approveTesterAccess(
  user,
  { client, env = process.env, createOnly = false } = {},
) {
  const userId = cleanUserId(user);
  const documentId = accessDocumentId(user, env);
  const provider = authProvider(user, env);
  const approvedAt = new Date().toISOString();
  try {
    try {
      await saveAccessDocument(
        documentId,
        {
          userId,
          authProvider: provider,
          status: "approved",
          approvedAt,
        },
        { client, env, createOnly },
      );
    } catch (error) {
      if (!createOnly || !isAccessDocumentConflict(error)) throw error;
      const existing = await loadAccessDocument(documentId, { client, env });
      if (!isApprovedAccess(existing, userId, provider)) {
        throw new TesterAccessError(
          "Този профил няма одобрен достъп.",
          403,
          "TESTER_ACCESS_NOT_APPROVED",
        );
      }
      return { userId, approvedAt: existing.approvedAt };
    }
  } catch (error) {
    if (error instanceof TesterAccessError) throw error;
    throw new TesterAccessError(
      "Одобрението на тестовия профил не можа да бъде запазено.",
      503,
      "TESTER_ACCESS_PERSISTENCE_FAILED",
    );
  }
  return { userId, approvedAt };
}

export async function approveTesterEmail(
  email,
  { client, env = process.env } = {},
) {
  const emailHash = cleanEmailHash(email, env);
  if (!emailHash) {
    throw new TesterAccessError(
      "Липсва валиден имейл за тестовия достъп.",
      400,
      "TESTER_ACCESS_INVALID_EMAIL",
    );
  }
  const approvedAt = new Date().toISOString();
  try {
    await saveAccessDocument(
      emailApprovalId(emailHash),
      { emailHash, status: "approved", approvedAt },
      { client, env },
    );
  } catch (error) {
    if (error instanceof TesterAccessError) throw error;
    throw new TesterAccessError(
      "Предварителното одобрение на тестовия профил не можа да бъде запазено.",
      503,
      "TESTER_ACCESS_PERSISTENCE_FAILED",
    );
  }
  return { emailHash, approvedAt };
}

// Public registration: every verified account may sign in unless an access
// record explicitly withholds it (for example status "revoked"). A missing
// record is not a reason to block. A storage failure fails closed with a
// temporary 503, so a revoked account cannot get back in during an outage.
export async function assertPublicAccountAccess(
  user,
  { client, env = process.env, logError = logSafeError } = {},
) {
  const userId = cleanUserId(user);
  const provider = authProvider(user, env);
  if (isPrimaryUser(userId, provider, env)) return true;
  let source = null;
  try {
    source = await loadAccessDocument(accessDocumentId(user, env), {
      client,
      env,
    });
  } catch (error) {
    if (error instanceof TesterAccessError) throw error;
    if (Number(statusCode(error)) !== 404) {
      logError("[Public account access]", error);
      throw new TesterAccessError(
        "Проверката на достъпа временно не е достъпна. Опитай отново след малко.",
        503,
        "TESTER_ACCESS_UNAVAILABLE",
      );
    }
  }
  if (source && !isApprovedAccess(source, userId, provider)) {
    throw new TesterAccessError(
      "Достъпът до този профил е спрян. Свържи се с поддръжката.",
      403,
      "ACCOUNT_ACCESS_REVOKED",
    );
  }
  return true;
}

// The one place that says whether an account is the owner by configuration.
// isPrimaryOwnerAccount adds the stored Google link on top of this.
export function isConfiguredPrimaryUser(user, env = process.env) {
  const userId = typeof user?.id === "string" ? user.id.trim() : "";
  if (!userId) return false;
  return isPrimaryUser(userId, authProvider(user, env), env);
}

function isPrimaryUser(userId, _provider, env = process.env) {
  const primaryUserId = String(env.SYNCHRON_PRIMARY_USER_ID || "").trim();
  return Boolean(primaryUserId) && userId === primaryUserId;
}

// The owner can sign in with GitHub and also with Google (Identity Platform).
// Those are different accounts with different ids, so the Google account is
// linked to the owner once: by finishing "Вход с Google" in a browser that
// already holds the verified owner GitHub session. The link lives in its own
// record, so a later access approval never overwrites it.
const PRIMARY_OWNER_CACHE_MS = 60_000;
const primaryOwnerCache = new Map();

function primaryOwnerLinkId(user, env = process.env) {
  return `primary-owner:${accessDocumentId(user, env)}`;
}

export function clearPrimaryOwnerCacheForTests() {
  primaryOwnerCache.clear();
}

export async function linkPrimaryOwnerAccount(
  user,
  { client, env = process.env } = {},
) {
  const userId = cleanUserId(user);
  const provider = authProvider(user, env);
  const linkedAt = new Date().toISOString();
  try {
    await saveAccessDocument(
      primaryOwnerLinkId(user, env),
      { userId, authProvider: provider, status: "linked", linkedAt },
      { client, env },
    );
  } catch (error) {
    if (error instanceof TesterAccessError) throw error;
    throw new TesterAccessError(
      "Свързването на профила със собственика не можа да бъде запазено.",
      503,
      "PRIMARY_OWNER_LINK_FAILED",
    );
  }
  primaryOwnerCache.delete(primaryOwnerLinkId(user, env));
  return { userId, authProvider: provider, linkedAt };
}

// True for the configured SYNCHRON_PRIMARY_USER_ID and for an account linked
// with linkPrimaryOwnerAccount. A storage failure answers false: the person
// stays a member for that request instead of getting owner rights by mistake.
export async function isPrimaryOwnerAccount(
  user,
  { client, env = process.env, logError = logSafeError } = {},
) {
  const userId = cleanUserId(user);
  const provider = authProvider(user, env);
  if (isPrimaryUser(userId, provider, env)) return true;
  const id = primaryOwnerLinkId(user, env);
  const cached = primaryOwnerCache.get(id);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  let value = false;
  try {
    const source = await loadAccessDocument(id, { client, env });
    value =
      source?.userId === userId &&
      source?.status === "linked" &&
      source?.authProvider === provider;
  } catch (error) {
    if (Number(statusCode(error)) !== 404) {
      logError("[Primary owner link]", error);
      return false;
    }
  }
  primaryOwnerCache.set(id, {
    value,
    expiresAt: Date.now() + PRIMARY_OWNER_CACHE_MS,
  });
  return value;
}

export async function assertTesterAccess(
  user,
  { client, env = process.env } = {},
) {
  const userId = cleanUserId(user);
  const provider = authProvider(user, env);
  if (isPrimaryUser(userId, provider, env)) return true;

  try {
    const source = await loadAccessDocument(accessDocumentId(user, env), {
      client,
      env,
    });
    if (isApprovedAccess(source, userId, provider)) {
      return true;
    }
  } catch (error) {
    if (error instanceof TesterAccessError) throw error;
    if (Number(statusCode(error)) !== 404) {
      throw new TesterAccessError(
        "Проверката на одобрения тестов профил временно не е достъпна.",
        503,
        "TESTER_ACCESS_UNAVAILABLE",
      );
    }
  }

  const emailHash = cleanEmailHash(user?.email, env);
  if (emailHash) {
    try {
      const source = await loadAccessDocument(emailApprovalId(emailHash), {
        client,
        env,
      });
      if (source?.emailHash === emailHash && source?.status === "approved") {
        return true;
      }
    } catch (error) {
      if (Number(statusCode(error)) !== 404) {
        throw new TesterAccessError(
          "Проверката на одобрения тестов профил временно не е достъпна.",
          503,
          "TESTER_ACCESS_UNAVAILABLE",
        );
      }
    }
  }

  throw new TesterAccessError(
    "Този профил няма одобрен тестов достъп.",
    403,
    "TESTER_ACCESS_NOT_APPROVED",
  );
}
