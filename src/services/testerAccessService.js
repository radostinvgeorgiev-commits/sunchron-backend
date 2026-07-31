import { createHash } from "node:crypto";

import { getOpenSearchClient } from "../config/opensearch.js";

const DEFAULT_INDEX = "synchron-tester-access-v1";

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
      "Supabase не върна валиден потребител.",
      502,
      "AUTH_INVALID_USER",
    );
  }
  return userId;
}

function cleanEmailHash(value) {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!email) return "";
  return createHash("sha256").update(email).digest("hex");
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

export async function approveTesterAccess(
  user,
  { client, env = process.env } = {},
) {
  const userId = cleanUserId(user);
  const approvedAt = new Date().toISOString();
  try {
    await requireClient(client).index({
      index: accessIndex(env),
      id: userId,
      body: {
        userId,
        status: "approved",
        approvedAt,
      },
      refresh: true,
    });
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
  const emailHash = cleanEmailHash(email);
  if (!emailHash) {
    throw new TesterAccessError(
      "Липсва валиден имейл за тестовия достъп.",
      400,
      "TESTER_ACCESS_INVALID_EMAIL",
    );
  }
  const approvedAt = new Date().toISOString();
  try {
    await requireClient(client).index({
      index: accessIndex(env),
      id: emailApprovalId(emailHash),
      body: {
        emailHash,
        status: "approved",
        approvedAt,
      },
      refresh: true,
    });
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
  const primaryUserId =
    typeof env.SYNCHRON_PRIMARY_SUPABASE_USER_ID === "string"
      ? env.SYNCHRON_PRIMARY_SUPABASE_USER_ID.trim()
      : "";
  if (primaryUserId && userId === primaryUserId) return true;

  const accessClient = requireClient(client);
  try {
    const response = await accessClient.get({
      index: accessIndex(env),
      id: userId,
    });
    const source = response.body?._source ?? response._source;
    if (source?.userId === userId && source?.status === "approved") {
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

  const emailHash = cleanEmailHash(user?.email);
  if (emailHash) {
    try {
      const response = await accessClient.get({
        index: accessIndex(env),
        id: emailApprovalId(emailHash),
      });
      const source = response.body?._source ?? response._source;
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
