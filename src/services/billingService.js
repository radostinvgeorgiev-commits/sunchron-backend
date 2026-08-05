/**
 * Billing service — token balance, consumption tracking, transaction history.
 *
 * Uses Supabase REST API with the service-role key so that server-side writes
 * bypass Row Level Security.  The publishable (anon) key is used as a
 * read-only fallback when the service-role key is absent.
 *
 * Expected Supabase tables (create via Supabase dashboard SQL editor):
 *
 *   CREATE TABLE IF NOT EXISTS public.token_balance (
 *     id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 *     user_id      uuid NOT NULL UNIQUE,
 *     tokens       bigint NOT NULL DEFAULT 0,
 *     last_updated timestamptz NOT NULL DEFAULT now()
 *   );
 *
 *   CREATE TABLE IF NOT EXISTS public.transactions (
 *     id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 *     user_id     uuid NOT NULL,
 *     amount      bigint NOT NULL,
 *     type        text NOT NULL CHECK (type IN ('purchase','consumption')),
 *     description text,
 *     created_at  timestamptz NOT NULL DEFAULT now()
 *   );
 *
 *   CREATE TABLE IF NOT EXISTS public.api_usage (
 *     id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 *     user_id     uuid NOT NULL,
 *     tokens_used bigint NOT NULL,
 *     model       text,
 *     endpoint    text,
 *     created_at  timestamptz NOT NULL DEFAULT now()
 *   );
 */

const DEFAULT_TIMEOUT_MS = 10_000;
const FREE_TOKENS_ON_SIGNUP = 10_000;

export class BillingError extends Error {
  constructor(message, status = 500, code = "BILLING_ERROR") {
    super(message);
    this.name = "BillingError";
    this.status = status;
    this.code = code;
  }
}

function normalizeProjectUrl(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" ? url.origin : "";
  } catch {
    return "";
  }
}

function billingConfig(env = process.env) {
  return {
    projectUrl: normalizeProjectUrl(env.SUPABASE_URL),
    serviceRoleKey: (env.SUPABASE_SERVICE_ROLE_KEY || "").trim(),
    publishableKey: (env.SUPABASE_PUBLISHABLE_KEY || "").trim(),
    freeTokens: Number.isFinite(Number(env.BILLING_FREE_TOKENS))
      ? Math.max(0, Number(env.BILLING_FREE_TOKENS))
      : FREE_TOKENS_ON_SIGNUP,
  };
}

export function isBillingConfigured(env = process.env) {
  const cfg = billingConfig(env);
  return Boolean(cfg.projectUrl && (cfg.serviceRoleKey || cfg.publishableKey));
}

async function supabaseRestRequest(
  cfg,
  path,
  { method = "GET", body } = {},
) {
  const authKey = cfg.serviceRoleKey || cfg.publishableKey;
  const response = await fetch(`${cfg.projectUrl}/rest/v1${path}`, {
    method,
    headers: {
      apikey: cfg.publishableKey || cfg.serviceRoleKey,
      Authorization: "Bearer " + authKey,
      "Content-Type": "application/json",
      Prefer: method === "POST" ? "return=representation" : "return=minimal",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const message =
      payload?.message ||
      payload?.hint ||
      payload?.error ||
      "Supabase REST върна " + response.status;
    throw new BillingError(message, response.status, "BILLING_UPSTREAM_ERROR");
  }

  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Return the token balance for a user, creating the row if absent.
 */
export async function getTokenBalance(userId, { env = process.env } = {}) {
  if (!userId) {
    throw new BillingError("Липсва user_id.", 400, "BILLING_BAD_REQUEST");
  }
  const cfg = billingConfig(env);
  if (!cfg.projectUrl) {
    throw new BillingError(
      "Billing не е конфигуриран.",
      503,
      "BILLING_NOT_CONFIGURED",
    );
  }

  const rows = await supabaseRestRequest(
    cfg,
    "/token_balance?user_id=eq." +
      encodeURIComponent(userId) +
      "&select=tokens,last_updated",
  );

  if (Array.isArray(rows) && rows.length > 0) {
    return {
      userId,
      tokens: Number(rows[0].tokens),
      lastUpdated: rows[0].last_updated,
    };
  }

  // First access: create a row with free tokens.
  const freeTokens = cfg.freeTokens;
  await supabaseRestRequest(cfg, "/token_balance", {
    method: "POST",
    body: { user_id: userId, tokens: freeTokens },
  });
  await supabaseRestRequest(cfg, "/transactions", {
    method: "POST",
    body: {
      user_id: userId,
      amount: freeTokens,
      type: "purchase",
      description: "Стартови безплатни токени",
    },
  });
  return {
    userId,
    tokens: freeTokens,
    lastUpdated: new Date().toISOString(),
  };
}

/**
 * Deduct tokens for an AI request.  Returns updated balance.
 * Throws BillingError with code BILLING_INSUFFICIENT_TOKENS if balance is too low.
 * Returns null when billing is not configured (allows the request to proceed).
 */
export async function consumeTokens(
  userId,
  tokensUsed,
  { env = process.env, model = null, endpoint = null } = {},
) {
  if (!userId) {
    throw new BillingError("Липсва user_id.", 400, "BILLING_BAD_REQUEST");
  }
  const amount = Math.max(1, Math.ceil(Number(tokensUsed) || 1));
  const cfg = billingConfig(env);
  if (!cfg.projectUrl) {
    // Billing not configured — silently allow the request.
    return null;
  }

  const current = await getTokenBalance(userId, { env });
  if (current.tokens < amount) {
    throw new BillingError(
      "Недостатъчен баланс. Имаш " +
        current.tokens +
        " токена, но са нужни " +
        amount +
        ".",
      402,
      "BILLING_INSUFFICIENT_TOKENS",
    );
  }

  const newBalance = current.tokens - amount;
  await supabaseRestRequest(
    cfg,
    "/token_balance?user_id=eq." + encodeURIComponent(userId),
    {
      method: "PATCH",
      body: { tokens: newBalance, last_updated: new Date().toISOString() },
    },
  );
  await supabaseRestRequest(cfg, "/transactions", {
    method: "POST",
    body: {
      user_id: userId,
      amount: -amount,
      type: "consumption",
      description: model ? "AI заявка (" + model + ")" : "AI заявка",
    },
  });
  await supabaseRestRequest(cfg, "/api_usage", {
    method: "POST",
    body: {
      user_id: userId,
      tokens_used: amount,
      model: model || null,
      endpoint: endpoint || null,
    },
  });

  return { userId, tokens: newBalance };
}

/**
 * Add tokens (purchase or admin grant).  Returns updated balance.
 */
export async function purchaseTokens(
  userId,
  amount,
  { env = process.env, description = "Покупка на токени" } = {},
) {
  if (!userId) {
    throw new BillingError("Липсва user_id.", 400, "BILLING_BAD_REQUEST");
  }
  const count = Math.ceil(Number(amount) || 0);
  if (count < 1) {
    throw new BillingError(
      "Количеството токени трябва да е положително число.",
      400,
      "BILLING_BAD_REQUEST",
    );
  }

  const cfg = billingConfig(env);
  if (!cfg.projectUrl) {
    throw new BillingError(
      "Billing не е конфигуриран.",
      503,
      "BILLING_NOT_CONFIGURED",
    );
  }

  const current = await getTokenBalance(userId, { env });
  const newBalance = current.tokens + count;

  await supabaseRestRequest(
    cfg,
    "/token_balance?user_id=eq." + encodeURIComponent(userId),
    {
      method: "PATCH",
      body: { tokens: newBalance, last_updated: new Date().toISOString() },
    },
  );
  await supabaseRestRequest(cfg, "/transactions", {
    method: "POST",
    body: {
      user_id: userId,
      amount: count,
      type: "purchase",
      description,
    },
  });

  return { userId, tokens: newBalance };
}

/**
 * Retrieve the last N transactions for a user.
 */
export async function getTransactions(
  userId,
  { env = process.env, limit = 20 } = {},
) {
  if (!userId) {
    throw new BillingError("Липсва user_id.", 400, "BILLING_BAD_REQUEST");
  }
  const cfg = billingConfig(env);
  if (!cfg.projectUrl) {
    throw new BillingError(
      "Billing не е конфигуриран.",
      503,
      "BILLING_NOT_CONFIGURED",
    );
  }

  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 20));
  const rows = await supabaseRestRequest(
    cfg,
    "/transactions?user_id=eq." +
      encodeURIComponent(userId) +
      "&order=created_at.desc&limit=" +
      safeLimit +
      "&select=id,amount,type,description,created_at",
  );

  return Array.isArray(rows) ? rows : [];
}
