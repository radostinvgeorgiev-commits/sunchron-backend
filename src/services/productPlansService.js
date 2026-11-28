import { createHash, randomUUID } from "node:crypto";
import { createFirestoreDocumentStore } from "./firestoreDocumentStore.js";

export const PRODUCT_PLANS = Object.freeze([
  Object.freeze({
    id: "free",
    name: "Старт",
    amountCents: 0,
    credits: 100,
    days: 30,
  }),
  Object.freeze({
    id: "personal",
    name: "Личен",
    amountCents: 299,
    credits: 300,
    days: 30,
  }),
  Object.freeze({
    id: "professional",
    name: "Професионален",
    amountCents: 999,
    credits: 1100,
    days: 30,
  }),
]);
const FREE_PLAN = PRODUCT_PLANS.find((plan) => plan.id === "free");
const LEGACY_STARTER_CREDITS = 10;
// Prices are the real cost plus a small reserve. One credit covers the most
// expensive single member request (about 0.8 euro cents at full context);
// a typical request costs far less.
export const PUBLIC_REQUEST_CREDITS = 1;
export const PUBLIC_DAILY_CREDIT_CAP = 1000;
export const PUBLIC_MONTHLY_CREDIT_CAP = 10_000;
// Plain conversation with an economical model costs no units (owner's
// decision 2026-11-26): up to this many messages a day per person, and a
// shared daily ceiling so the bill stays bounded. Past it, units are used.
export const FREE_CHAT_DAILY_PER_PERSON = 50;
export const FREE_CHAT_DAILY_TOTAL = 3000;
export const COUNCIL_REQUEST_CREDITS = 6;
// The largest single charge: one generated video (see publicAiBudget.js).
export const MAX_RESERVE_CREDITS = 100;
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
    // The free allocation renews every 30 days, and an expired paid plan
    // falls back to it, so nobody is left without a way to use the site.
    if (data && Number(data.expiresAt) <= now() && data.plan !== "owner") {
      return {
        ...data,
        plan: "free",
        remaining: FREE_PLAN.credits,
        expiresAt: now() + FREE_PLAN.days * 86400000,
        starterCredits: FREE_PLAN.credits,
      };
    }
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
  // The size of the current allowance, for the ring that fills as units are
  // spent. A paid pack is added on top of the free units, so both count.
  function allowance(planId, remaining) {
    const plan = PRODUCT_PLANS.find((item) => item.id === planId);
    const size =
      planId === "free" || !plan
        ? FREE_PLAN.credits
        : plan.credits + FREE_PLAN.credits;
    return Math.max(size, remaining);
  }
  async function usage(identity) {
    if (identity.role === "owner")
      return { plan: "owner", remaining: null, owner: true };
    const { data } = await account(productAccountId(identity));
    const remaining = balance(data);
    return {
      plan: data.plan,
      remaining,
      allowance: allowance(data.plan, remaining),
      expiresAt: data.expiresAt,
      owner: false,
    };
  }
  async function reserve(identity, credits, details = {}) {
    if (identity.role === "owner") return;
    if (!Number.isInteger(credits) || credits < 1 || credits > MAX_RESERVE_CREDITS)
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
      // Shared safety cap for all members together (owner's decision
      // 2026-11-26): about 30–50 active people a day, at most ~80 € a month.
      const monthlyLimit =
        Number(env.PUBLIC_AI_MONTHLY_CREDIT_CAP) || PUBLIC_MONTHLY_CREDIT_CAP;
      const dailyLimit =
        Number(env.PUBLIC_AI_DAILY_CREDIT_CAP) || PUBLIC_DAILY_CREDIT_CAP;
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
        return reservationId;
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
  // Gives the units of one reservation back when the paid work did not
  // happen (for example a video the provider could not make). Each
  // reservation is returned at most once, and only to its own account.
  async function refund(identity, reservationId) {
    if (identity?.role === "owner" || typeof reservationId !== "string") return false;
    const id = productAccountId(identity);
    for (let attempt = 0; attempt < 5; attempt++) {
      const database = db();
      const entry = await database.get(LEDGER_COLLECTION, reservationId, { includeMetadata: true });
      const reserved = entry?.data;
      if (!reserved || reserved.account !== id || reserved.refundedAt) return false;
      const credits = Number(reserved.credits) || 0;
      const row = await account(id);
      const month = new Date(Number(reserved.createdAt) || now()).toISOString().slice(0, 7);
      const day = new Date(Number(reserved.createdAt) || now()).toISOString().slice(0, 10);
      const globalId = `public-${month}`;
      const globalRow = await database.get(LEDGER_COLLECTION, globalId, { includeMetadata: true });
      const operations = [
        {
          type: "set",
          collection: LEDGER_COLLECTION,
          id: reservationId,
          data: { ...reserved, refundedAt: now() },
          updateTime: entry.updateTime,
        },
        {
          type: "set",
          collection: ACCOUNT_COLLECTION,
          id,
          data: { ...row.data, remaining: balance(row.data) + credits, updatedAt: now() },
          ...(row.updateTime ? { updateTime: row.updateTime } : { createOnly: true }),
        },
      ];
      if (globalRow?.data) {
        const total = globalRow.data;
        operations.push({
          type: "set",
          collection: LEDGER_COLLECTION,
          id: globalId,
          data: {
            ...total,
            used: Math.max(0, (Number(total.used) || 0) - credits),
            dayUsed: total.day === day ? Math.max(0, (Number(total.dayUsed) || 0) - credits) : total.dayUsed,
          },
          updateTime: globalRow.updateTime,
        });
      }
      try {
        await database.commitOperations(operations);
        return true;
      } catch (error) {
        if (!conflict(error)) throw error;
      }
    }
    return false;
  }
  // Counts one free conversation turn. Returns false when today's free turns
  // are used up (for this person or for everybody), so the turn uses units.
  async function useFreeChat(identity) {
    if (identity.role === "owner") return true;
    const id = productAccountId(identity);
    const day = new Date(now()).toISOString().slice(0, 10);
    const personId = `free-${day}-${id}`;
    const totalId = `free-${day}-all`;
    const perPerson =
      Number(env.FREE_CHAT_DAILY_PER_PERSON) || FREE_CHAT_DAILY_PER_PERSON;
    const total = Number(env.FREE_CHAT_DAILY_TOTAL) || FREE_CHAT_DAILY_TOTAL;
    for (let attempt = 0; attempt < 5; attempt++) {
      const database = db();
      const [mine, all] = await Promise.all([
        database.get(LEDGER_COLLECTION, personId, { includeMetadata: true }),
        database.get(LEDGER_COLLECTION, totalId, { includeMetadata: true }),
      ]);
      const used = Number(mine?.data?.used) || 0;
      const usedAll = Number(all?.data?.used) || 0;
      if (used >= perPerson || usedAll >= total) return false;
      try {
        await database.commitOperations([
          {
            type: "set",
            collection: LEDGER_COLLECTION,
            id: personId,
            data: { used: used + 1, day },
            ...(mine?.updateTime ? { updateTime: mine.updateTime } : { createOnly: true }),
          },
          {
            type: "set",
            collection: LEDGER_COLLECTION,
            id: totalId,
            data: { used: usedAll + 1, day },
            ...(all?.updateTime ? { updateTime: all.updateTime } : { createOnly: true }),
          },
        ]);
        return true;
      } catch (error) {
        if (!conflict(error)) throw error;
      }
    }
    return false;
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
  return { usage, reserve, refund, useFreeChat, fulfill };
}
let runtimeService;
export function getProductPlansService() {
  return (runtimeService ||= createProductPlansService());
}
