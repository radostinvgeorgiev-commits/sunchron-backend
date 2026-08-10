import { createHash } from "node:crypto";

const IDENTITY_TOOLKIT_ORIGIN = "https://identitytoolkit.googleapis.com";
const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_BATCH_SIZE = 500;
const MAX_BATCH_SIZE = 1_000;
const MAX_USERS = 20_000;
const CONFIRM_PREFIX = "MIGRATE_SUPABASE_USERS_TO_IDENTITY_PLATFORM:";
const BCRYPT_PATTERN = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/u;
const SOURCE_USER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TARGET_USER_ID_PATTERN = /^[^\u0000-\u001f\u007f/]{1,128}$/u;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export class IdentityPlatformUserMigrationError extends Error {
  constructor(message, code = "IDENTITY_USER_MIGRATION_FAILED") {
    super(message);
    this.name = "IdentityPlatformUserMigrationError";
    this.code = code;
  }
}

function migrationError(message, code) {
  return new IdentityPlatformUserMigrationError(message, code);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function cleanProjectId(value) {
  const clean = String(value || "").trim();
  if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/u.test(clean)) {
    throw migrationError(
      "Невалиден Google Cloud project ID.",
      "IDENTITY_USER_MIGRATION_CONFIGURATION_INVALID",
    );
  }
  return clean;
}

function cleanSourceUserId(value) {
  const clean = String(value || "").trim();
  if (!SOURCE_USER_ID_PATTERN.test(clean)) {
    throw migrationError(
      "Невалиден Supabase user ID.",
      "IDENTITY_USER_MIGRATION_SOURCE_INVALID",
    );
  }
  return clean;
}

function cleanTargetUserId(value) {
  const clean = String(value || "").trim();
  if (!TARGET_USER_ID_PATTERN.test(clean)) {
    throw migrationError(
      "Невалиден Identity Platform user ID.",
      "IDENTITY_USER_MIGRATION_TARGET_INVALID",
    );
  }
  return clean;
}

function cleanEmail(value) {
  const clean = String(value || "")
    .trim()
    .toLowerCase();
  if (clean.length > 254 || !EMAIL_PATTERN.test(clean)) {
    throw migrationError(
      "Невалиден Supabase user email.",
      "IDENTITY_USER_MIGRATION_SOURCE_INVALID",
    );
  }
  return clean;
}

function optionalTimestampMs(value, label) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Date.parse(String(value));
  if (!Number.isFinite(parsed)) {
    throw migrationError(
      `Невалиден ${label}.`,
      "IDENTITY_USER_MIGRATION_SOURCE_INVALID",
    );
  }
  return parsed;
}

function displayNameFromMetadata(value) {
  const metadata = value && typeof value === "object" ? value : {};
  return String(
    metadata.display_name || metadata.full_name || metadata.name || "",
  )
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .trim()
    .slice(0, 80);
}

function positiveInteger(value, fallback, maximum) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

function normalizedSourceUser(row, nowMs) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw migrationError(
      "Supabase user export съдържа невалиден ред.",
      "IDENTITY_USER_MIGRATION_SOURCE_INVALID",
    );
  }
  const localId = cleanSourceUserId(row.id ?? row.localId);
  const email = cleanEmail(row.email);
  const encryptedPassword = String(
    row.encrypted_password ?? row.encryptedPassword ?? "",
  ).trim();
  if (!BCRYPT_PATTERN.test(encryptedPassword)) {
    throw migrationError(
      "Supabase user няма поддържан BCRYPT password hash.",
      "IDENTITY_USER_MIGRATION_HASH_UNSUPPORTED",
    );
  }
  const createdAt = optionalTimestampMs(
    row.created_at ?? row.createdAt,
    "created_at",
  );
  if (createdAt === null) {
    throw migrationError(
      "Supabase user няма created_at.",
      "IDENTITY_USER_MIGRATION_SOURCE_INVALID",
    );
  }
  const lastLoginAt = optionalTimestampMs(
    row.last_sign_in_at ?? row.lastLoginAt,
    "last_sign_in_at",
  );
  const passwordUpdatedAt =
    optionalTimestampMs(row.updated_at ?? row.updatedAt, "updated_at") ??
    createdAt;
  const bannedUntil = optionalTimestampMs(
    row.banned_until ?? row.bannedUntil,
    "banned_until",
  );
  const deletedAt = optionalTimestampMs(
    row.deleted_at ?? row.deletedAt,
    "deleted_at",
  );
  const emailConfirmedAt = optionalTimestampMs(
    row.email_confirmed_at ?? row.emailConfirmedAt,
    "email_confirmed_at",
  );
  return Object.freeze({
    localId,
    email,
    displayName: displayNameFromMetadata(
      row.raw_user_meta_data ?? row.userMetadata,
    ),
    emailVerified: emailConfirmedAt !== null,
    disabled:
      deletedAt !== null || (bannedUntil !== null && bannedUntil > nowMs),
    passwordHash: Buffer.from(encryptedPassword, "utf8").toString("base64"),
    createdAt: String(createdAt),
    lastLoginAt: lastLoginAt === null ? null : String(lastLoginAt),
    passwordUpdatedAt,
  });
}

export function normalizeSupabaseUserExport(rows, { now = Date.now } = {}) {
  if (!Array.isArray(rows)) {
    throw migrationError(
      "Supabase user export трябва да е JSON array.",
      "IDENTITY_USER_MIGRATION_SOURCE_INVALID",
    );
  }
  if (rows.length > MAX_USERS) {
    throw migrationError(
      "Supabase user export надвишава безопасния лимит.",
      "IDENTITY_USER_MIGRATION_LIMIT_EXCEEDED",
    );
  }
  const nowMs = Number(now());
  const users = rows.map((row) => normalizedSourceUser(row, nowMs));
  const ids = new Set();
  const emails = new Set();
  for (const user of users) {
    if (ids.has(user.localId) || emails.has(user.email)) {
      throw migrationError(
        "Supabase user export съдържа дублиран ID или email.",
        "IDENTITY_USER_MIGRATION_SOURCE_CONFLICT",
      );
    }
    ids.add(user.localId);
    emails.add(user.email);
  }
  return Object.freeze(
    users.sort((left, right) => left.localId.localeCompare(right.localId)),
  );
}

function normalizeTargetUser(user) {
  const localId = cleanTargetUserId(user?.localId);
  const rawEmail = String(user?.email || "")
    .trim()
    .toLowerCase();
  const email =
    rawEmail.length <= 254 && EMAIL_PATTERN.test(rawEmail) ? rawEmail : "";
  return Object.freeze({
    localId,
    email,
    displayName: String(user?.displayName || "")
      .trim()
      .slice(0, 80),
    emailVerified: user?.emailVerified === true,
    disabled: user?.disabled === true,
    passwordHash: String(user?.passwordHash || "").trim(),
  });
}

function comparableSourceUser(user) {
  return {
    localId: user.localId,
    email: user.email,
    displayName: user.displayName,
    emailVerified: user.emailVerified,
    disabled: user.disabled,
    passwordHash: user.passwordHash,
  };
}

function comparableTargetUser(user) {
  return {
    localId: user.localId,
    email: user.email,
    displayName: user.displayName,
    emailVerified: user.emailVerified,
    disabled: user.disabled,
    passwordHash: user.passwordHash,
  };
}

function buildPlanInternal(sourceUsers, targetUsers) {
  const normalizedTargets = targetUsers
    .map(normalizeTargetUser)
    .sort((left, right) => left.localId.localeCompare(right.localId));
  const targetById = new Map(
    normalizedTargets.map((user) => [user.localId, user]),
  );
  const targetByEmail = new Map(
    normalizedTargets
      .filter((user) => user.email)
      .map((user) => [user.email, user]),
  );
  const usersToImport = [];
  let alreadyPresent = 0;
  for (const source of sourceUsers) {
    const idMatch = targetById.get(source.localId);
    const emailMatch = targetByEmail.get(source.email);
    if (emailMatch && emailMatch.localId !== source.localId) {
      throw migrationError(
        "Identity Platform съдържа email с различен user ID.",
        "IDENTITY_USER_MIGRATION_TARGET_CONFLICT",
      );
    }
    if (!idMatch) {
      usersToImport.push(source);
      continue;
    }
    if (
      stableJson(comparableTargetUser(idMatch)) !==
      stableJson(comparableSourceUser(source))
    ) {
      throw migrationError(
        "Identity Platform съдържа различен профил със същия user ID.",
        "IDENTITY_USER_MIGRATION_TARGET_CONFLICT",
      );
    }
    alreadyPresent += 1;
  }
  const sourceFingerprint = sha256(stableJson(sourceUsers));
  const targetFingerprint = sha256(stableJson(normalizedTargets));
  const fingerprint = sha256(
    stableJson({ sourceFingerprint, targetFingerprint }),
  );
  return {
    sourceUsers,
    usersToImport,
    sourceFingerprint,
    targetFingerprint,
    fingerprint,
    confirmation: `${CONFIRM_PREFIX}${fingerprint}`,
    alreadyPresent,
    targetUsers: normalizedTargets.length,
  };
}

function publicPlan(plan) {
  return Object.freeze({
    mode: "plan",
    hashAlgorithm: "BCRYPT",
    sourceIdsPreserved: true,
    sourceUsers: plan.sourceUsers.length,
    targetUsers: plan.targetUsers,
    usersToImport: plan.usersToImport.length,
    alreadyPresent: plan.alreadyPresent,
    verifiedEmails: plan.sourceUsers.filter((user) => user.emailVerified)
      .length,
    disabledUsers: plan.sourceUsers.filter((user) => user.disabled).length,
    sourceFingerprint: plan.sourceFingerprint,
    targetFingerprint: plan.targetFingerprint,
    confirmation: plan.confirmation,
  });
}

export function createSupabaseIdentityMigrationPlan({
  sourceRows,
  targetUsers = [],
  now = Date.now,
} = {}) {
  const sourceUsers = normalizeSupabaseUserExport(sourceRows, { now });
  return publicPlan(buildPlanInternal(sourceUsers, targetUsers));
}

function safeUpstreamCode(payload) {
  const value = String(payload?.error?.status || payload?.error?.message || "")
    .split(/[\s:]/u)[0]
    .trim();
  return /^[A-Z0-9_]{1,80}$/u.test(value) ? value : null;
}

export function createIdentityPlatformMigrationClient({
  projectId,
  fetchImpl = globalThis.fetch,
  accessTokenProvider,
  env = process.env,
  now = Date.now,
} = {}) {
  const cleanProject = cleanProjectId(
    projectId || env.IDENTITY_PLATFORM_PROJECT_ID || env.GOOGLE_CLOUD_PROJECT,
  );
  if (typeof fetchImpl !== "function") {
    throw migrationError(
      "Липсва HTTP client.",
      "IDENTITY_USER_MIGRATION_CONFIGURATION_INVALID",
    );
  }
  const timeoutMs = positiveInteger(
    env.IDENTITY_USER_MIGRATION_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    120_000,
  );
  let cachedToken = null;

  async function metadataAccessToken({ force = false } = {}) {
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
      const error = migrationError(
        "Cloud Run migration service identity не е достъпна.",
        "IDENTITY_USER_MIGRATION_CREDENTIALS_UNAVAILABLE",
      );
      error.cause = cause;
      throw error;
    } finally {
      clearTimeout(timer);
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.access_token) {
      throw migrationError(
        "Cloud Run migration service identity не върна access token.",
        "IDENTITY_USER_MIGRATION_CREDENTIALS_UNAVAILABLE",
      );
    }
    cachedToken = {
      value: payload.access_token,
      expiresAt: now() + Math.max(1, Number(payload.expires_in) || 300) * 1000,
    };
    return cachedToken.value;
  }

  const tokenProvider = accessTokenProvider || metadataAccessToken;

  async function request(url, { method = "GET", body } = {}) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await tokenProvider({ force: attempt > 0 });
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
        const error = migrationError(
          "Identity Platform migration API не отговори.",
          "IDENTITY_USER_MIGRATION_TARGET_UNAVAILABLE",
        );
        error.cause = cause;
        throw error;
      } finally {
        clearTimeout(timer);
      }
      const payload = await response.json().catch(() => ({}));
      if (response.status === 401 && attempt === 0) {
        cachedToken = null;
        continue;
      }
      if (!response.ok) {
        const error = migrationError(
          "Identity Platform migration request е неуспешна.",
          "IDENTITY_USER_MIGRATION_TARGET_UNAVAILABLE",
        );
        error.upstreamStatus = response.status;
        error.upstreamCode = safeUpstreamCode(payload);
        throw error;
      }
      return payload;
    }
    throw migrationError(
      "Identity Platform migration authentication е неуспешна.",
      "IDENTITY_USER_MIGRATION_CREDENTIALS_UNAVAILABLE",
    );
  }

  return Object.freeze({
    projectId: cleanProject,
    async listUsers() {
      const users = [];
      let nextPageToken = "";
      do {
        const url = new URL(
          `/v1/projects/${encodeURIComponent(cleanProject)}/accounts:batchGet`,
          IDENTITY_TOOLKIT_ORIGIN,
        );
        url.searchParams.set("maxResults", "1000");
        if (nextPageToken) url.searchParams.set("nextPageToken", nextPageToken);
        const payload = await request(url);
        users.push(...(Array.isArray(payload.users) ? payload.users : []));
        if (users.length > MAX_USERS) {
          throw migrationError(
            "Identity Platform users надвишават безопасния лимит.",
            "IDENTITY_USER_MIGRATION_LIMIT_EXCEEDED",
          );
        }
        nextPageToken = String(payload.nextPageToken || "");
      } while (nextPageToken);
      return users;
    },
    async importUsers(users) {
      const url = new URL(
        `/v1/projects/${encodeURIComponent(cleanProject)}/accounts:batchCreate`,
        IDENTITY_TOOLKIT_ORIGIN,
      );
      return request(url, {
        method: "POST",
        body: {
          hashAlgorithm: "BCRYPT",
          sanityCheck: true,
          allowOverwrite: false,
          users,
        },
      });
    },
  });
}

function identityUserPayload(user) {
  return {
    localId: user.localId,
    email: user.email,
    displayName: user.displayName,
    emailVerified: user.emailVerified,
    disabled: user.disabled,
    passwordHash: user.passwordHash,
    createdAt: user.createdAt,
    ...(user.lastLoginAt ? { lastLoginAt: user.lastLoginAt } : {}),
    passwordUpdatedAt: user.passwordUpdatedAt,
  };
}

export function createPreservedIdentityMap(
  sourceRows,
  { now = Date.now } = {},
) {
  return Object.fromEntries(
    normalizeSupabaseUserExport(sourceRows, { now }).map((user) => [
      user.localId,
      user.localId,
    ]),
  );
}

export async function applySupabaseIdentityMigration({
  sourceRows,
  client,
  confirmation,
  now = Date.now,
  batchSize = DEFAULT_BATCH_SIZE,
} = {}) {
  if (!client?.listUsers || !client?.importUsers) {
    throw migrationError(
      "Identity Platform migration client не е конфигуриран.",
      "IDENTITY_USER_MIGRATION_TARGET_UNAVAILABLE",
    );
  }
  const sourceUsers = normalizeSupabaseUserExport(sourceRows, { now });
  const initialTargets = await client.listUsers();
  const plan = buildPlanInternal(sourceUsers, initialTargets);
  if (String(confirmation || "").trim() !== plan.confirmation) {
    throw migrationError(
      "Липсва точното identity migration confirmation.",
      "IDENTITY_USER_MIGRATION_CONFIRMATION_REQUIRED",
    );
  }
  const safeBatchSize = positiveInteger(
    batchSize,
    DEFAULT_BATCH_SIZE,
    MAX_BATCH_SIZE,
  );
  let submittedUsers = 0;
  for (
    let offset = 0;
    offset < plan.usersToImport.length;
    offset += safeBatchSize
  ) {
    const batch = plan.usersToImport.slice(offset, offset + safeBatchSize);
    await client.importUsers(batch.map(identityUserPayload));
    submittedUsers += batch.length;
  }

  const verifiedTargets = (await client.listUsers()).map(normalizeTargetUser);
  const targetById = new Map(
    verifiedTargets.map((user) => [user.localId, user]),
  );
  let verifiedUsers = 0;
  for (const source of sourceUsers) {
    const target = targetById.get(source.localId);
    if (
      !target ||
      stableJson(comparableTargetUser(target)) !==
        stableJson(comparableSourceUser(source))
    ) {
      throw migrationError(
        "Identity Platform post-import verification е неуспешна.",
        "IDENTITY_USER_MIGRATION_VERIFICATION_FAILED",
      );
    }
    verifiedUsers += 1;
  }
  return Object.freeze({
    ...publicPlan(plan),
    mode: "applied",
    submittedUsers,
    verifiedUsers,
    identityMapEntries: sourceUsers.length,
  });
}

export const IDENTITY_USER_MIGRATION_CONFIRM_PREFIX = CONFIRM_PREFIX;
