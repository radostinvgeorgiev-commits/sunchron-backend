import { createHash, randomUUID } from "node:crypto";
import { createFirestoreDocumentStore } from "./firestoreDocumentStore.js";

export const PRODUCT_PLANS = Object.freeze([
  Object.freeze({
    id: "free",
    name: "Старт",
    amountCents: 0,
    credits: 30,
    days: 30,
  }),
  Object.freeze({
    id: "personal",
    name: "Личен",
    amountCents: 990,
    credits: 100,
    days: 30,
  }),
  Object.freeze({
    id: "professional",
    name: "Професионален",
    amountCents: 2490,
    credits: 350,
    days: 30,
  }),
]);
const FREE_PLAN = PRODUCT_PLANS.find((plan) => plan.id === "free");
const LEGACY_STARTER_CREDITS = 10;
export const PUBLIC_REQUEST_CREDITS = 3;
export const COUNCIL_REQUEST_CREDITS = 18;
export const ACCOUNT_COLLECTION = "synchron-product-accounts-v1";
const LEDGER_COLLECTION = "synchron-product-events-v1";
export class ProductError extends Error {
  constructor(message, code = "PRODUCT_UNAVAILABLE", status = 503) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
export function productAccountId(identity) {
  const owner = identity?.memoryOwnerId;
  if (typeof owner !== "string" || !owner.trim())
    throw new ProductError("Влез в профила си.", "AUTH_REQUIRED", 401);
  return createHash("sha256").update(owner).digest("hex");
}
function conflict(error) {
  return (
    [409, 412].includes(error?.upstreamStatus) ||
    ["FAILED_PRECONDITION", "ABORTED", "ALREADY_EXISTS"].includes(
      error?.upstreamErrorStatus,
    )
  );
}
export function createProductPlansService({
  store,
  env = process.env,
  now = () => Date.now(),
} = {}) {
  let runtimeStore = store;
  const db = () => (runtimeStore ||= createFirestoreDocumentStore({ env }));
  const initial = () => ({
    plan: "free",
    remaining: FREE_PLAN.credits,
    expiresAt: now() + FREE_PLAN.days * 86400000,
    createdAt: now(),
    starterCredits: FREE_PLAN.credits,
  });
  // Free accounts created when the starter allocation was 10 receive the
  // difference once. The grant is persisted with the next CAS write, so a
  // retry or a concurrent read can never apply it twice.
  function withStarterCredits(data) {
    if (data?.plan !== "free") return data;
    const granted = Number(data.starterCredits) || LEGACY_STARTER_CREDITS;
    if (granted >= FREE_PLAN.credits) return data;
    return {
      ...data,
      remaining: (Number(data.remaining) || 0) + FREE_PLAN.credits - granted,
      starterCredits: FREE_PLAN.credits,
    };
  }
  async function account(id) {
    const row = await db().get(ACCOUNT_COLLECTION, id, {
      includeMetadata: true,
    });
    if (!row) return { data: initial(), updateTime: null };
    return { ...row, data: withStarterCredits(row.data) };
  }
  function balance(data) {
    return data.expiresAt > now()
      ? Math.max(0, Number(data.remaining) || 0)
      : 0;
  }
  async function usage(identity) {
    if (identity.role === "owner")
      return { plan: "owner", remaining: null, owner: true };
    const { data } = await account(productAccountId(identity));
    return {
      plan: data.plan,
      remaining: balance(data),
      expiresAt: data.expiresAt,
      owner: false,
    };
  }
  async function reserve(identity, credits, details = {}) {
    if (identity.role === "owner") return;
    if (!Number.isInteger(credits) || credits < 1 || credits > 18)
      throw new ProductError("Невалидно потребление.");
    const id = productAccountId(identity);
    const reservationId = `ai_${randomUUID()}`;
    for (let attempt = 0; attempt < 5; attempt++) {
      const database = db();
      const row = await account(id);
      const data = row.data;
      const month = new Date(now()).toISOString().slice(0, 7);
      const day = new Date(now()).toISOString().slice(0, 10);
      const globalId = `public-${month}`;
      const globalRow = await database.get(LEDGER_COLLECTION, globalId, {
        includeMetadata: true,
      });
      const total = globalRow?.data || { used: 0, day, dayUsed: 0 };
      const daily = total.day === day ? Number(total.dayUsed) || 0 : 0;
      const monthlyLimit = Number(env.PUBLIC_AI_MONTHLY_CREDIT_CAP) || 3000;
      const dailyLimit = Number(env.PUBLIC_AI_DAILY_CREDIT_CAP) || 300;
      if (total.used + credits > monthlyLimit || daily + credits > dailyLimit)
        throw new ProductError(
          "Временният общ лимит за AI е достигнат. Опитай по-късно.",
          "AI_CAPACITY_LIMIT",
          429,
        );
      if (balance(data) < credits)
        throw new ProductError(
          "Нямаш достатъчно AI единици. Виж „Планове и потребление“.",
          "AI_CREDITS_EXHAUSTED",
          402,
        );
      try {
        await database.commitOperations([
          {
            type: "set",
            collection: LEDGER_COLLECTION,
            id: reservationId,
            createOnly: true,
            data: {
              account: id,
              credits,
              createdAt: now(),
              provider: String(details.provider || "").slice(0, 80),
              model: String(details.model || "").slice(0, 120),
            },
          },
          {
            type: "set",
            collection: ACCOUNT_COLLECTION,
            id,
            data: {
              ...data,
              remaining: balance(data) - credits,
              updatedAt: now(),
            },
            ...(row.updateTime
              ? { updateTime: row.updateTime }
              : { createOnly: true }),
          },
          {
            type: "set",
            collection: LEDGER_COLLECTION,
            id: globalId,
            data: { used: total.used + credits, day, dayUsed: daily + credits },
            ...(globalRow?.updateTime
              ? { updateTime: globalRow.updateTime }
              : { createOnly: true }),
          },
        ]);
        return;
      } catch (error) {
        if (!conflict(error)) throw error;
      }
    }
    throw new ProductError(
      "Има едновременни заявки. Опитай отново.",
      "USAGE_CONFLICT",
      409,
    );
  }
  async function fulfill(session) {
    const plan = PRODUCT_PLANS.find(
      (p) => p.id === session?.metadata?.plan && p.amountCents > 0,
    );
    const id = session?.metadata?.account;
    if (
      !plan ||
      !/^[a-f0-9]{64}$/.test(id || "") ||
      session.payment_status !== "paid" ||
      session.currency !== "eur" ||
      session.amount_total !== plan.amountCents ||
      session.mode !== "payment" ||
      !/^cs_[A-Za-z0-9_]+$/.test(session.id || "")
    )
      throw new ProductError(
        "Невалидно потвърждение за плащане.",
        "PAYMENT_INVALID",
        400,
      );
    const receiptId = session.id;
    for (let attempt = 0; attempt < 5; attempt++) {
      const database = db();
      if (await database.get(LEDGER_COLLECTION, receiptId))
        return { duplicate: true };
      const row = await account(id);
      const data = row.data;
      try {
        await database.commitOperations([
          {
            type: "set",
            collection: ACCOUNT_COLLECTION,
            id,
            data: {
              ...data,
              plan: plan.id,
              remaining: balance(data) + plan.credits,
              expiresAt: Math.max(
                Number(data.expiresAt) || 0,
                now() + plan.days * 86400000,
              ),
              updatedAt: now(),
            },
            ...(row.updateTime
              ? { updateTime: row.updateTime }
              : { createOnly: true }),
          },
          {
            type: "set",
            collection: LEDGER_COLLECTION,
            id: receiptId,
            createOnly: true,
            data: {
              account: id,
              plan: plan.id,
              amountCents: plan.amountCents,
              credits: plan.credits,
              createdAt: now(),
            },
          },
        ]);
        return { applied: true };
      } catch (error) {
        if (!conflict(error)) throw error;
      }
    }
    throw new ProductError("Плащането чака обработка.", "PAYMENT_RETRY", 503);
  }
  return { usage, reserve, fulfill };
}
let runtimeService;
export function getProductPlansService() {
  return (runtimeService ||= createProductPlansService());
}
