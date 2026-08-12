import { createHash, createHmac } from "node:crypto";

import { resolveAuthBackend } from "../config/authBackend.js";
import { resolvePersistenceBackend } from "../config/memoryBackend.js";
import { createFirestoreTesterAccessStore } from "./firestoreTesterAccessStore.js";

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

async function saveAccessDocument(id, body, { client, env }) {
  const backend = resolvePersistenceBackend(env);
  if (backend !== "firestore") {
    throw new TesterAccessError(
      "Проверката на одобрените тестови профили има невалидна storage конфигурация.",
      503,
      "TESTER_ACCESS_UNAVAILABLE",
    );
  }
  await getFirestoreStore(env).set(id, body);
}

async function loadAccessDocument(id, { client, env }) {
  const backend = resolvePersistenceBackend(env);
  if (backend !== "firestore") {
    throw new TesterAccessError(
      "Проверката на одобрените тестови профили има невалидна storage конфигурация.",
      503,
      "TESTER_ACCESS_UNAVAILABLE",
    );
  }
  return (await getFirestoreStore(env).get(id))?.data || null;
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

function statusCode(error) {
  return error?.statusCode || error?.meta?.statusCode || error?.status;
}

export async function approveTesterAccess(
  user,
  { client, env = process.env } = {},
) {
  const userId = cleanUserId(user);
  const documentId = accessDocumentId(user, env);
  const provider = authProvider(user, env);
  const approvedAt = new Date().toISOString();
  try {
    await saveAccessDocument(
      documentId,
      {
        userId,
        authProvider: provider,
        status: "approved",
        approvedAt,
      },
      { client, env },
    );
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

export async function assertTesterAccess(
  user,
  { client, env = process.env } = {},
) {
  const userId = cleanUserId(user);
  const provider = authProvider(user, env);
  const primaryUserId = String(
    env.SYNCHRON_PRIMARY_USER_ID ||
      "",
  ).trim();
  if (primaryUserId && userId === primaryUserId) return true;

  try {
    const source = await loadAccessDocument(accessDocumentId(user, env), {
      client,
      env,
    });
    if (
      source?.userId === userId &&
      source?.status === "approved" &&
      (!source.authProvider || source.authProvider === provider)
    ) {
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
