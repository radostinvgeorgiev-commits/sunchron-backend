import { createHash } from "node:crypto";

import { createFirestoreDocumentStore } from "./firestoreDocumentStore.js";
import { logSafeError } from "../utils/safeLogging.js";

// Daily counts for the owner's „Активност“ page. Only numbers are kept:
// no names, addresses or message text. A person counts as active once a day
// through a one-way hash of their account id.
const DAILY = "activity_daily";
const SEEN = "activity_seen";
const MAX_DAYS = 31;
export const ACTIVITY_FIELDS = Object.freeze([
  "landing_variant_1",
  "landing_variant_2",
  "landing_variant_3",
  "landing_smoke_test",
  "registrations",
  "registrations_campaign",
  "early_access",
  "messages",
  "active",
]);

export function activityDay(time = Date.now()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Sofia",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(time));
}

export function campaignField(prefix, attribution) {
  const variant = String(attribution?.utm_content || "");
  return /^(?:variant-[123]|smoke-test)$/u.test(variant)
    ? `${prefix}_${variant.replace(/-/gu, "_")}`
    : null;
}

export function createActivityService({ store = null, now = () => Date.now() } = {}) {
  let resolvedStore = store;
  const getStore = () => (resolvedStore ||= createFirestoreDocumentStore());
  const seenToday = new Set();

  async function bump(fields) {
    const clean = Object.fromEntries(
      Object.entries(fields).filter(([field]) => ACTIVITY_FIELDS.includes(field)),
    );
    if (!Object.keys(clean).length) return;
    await getStore().increment(DAILY, activityDay(now()), clean);
  }

  async function markActive(accountId) {
    const id = String(accountId || "").trim();
    if (!id) return;
    const day = activityDay(now());
    const hash = createHash("sha256").update(`aicore-activity\0${id}`).digest("hex").slice(0, 24);
    const key = `${day}_${hash}`;
    if (seenToday.has(key)) return;
    if (seenToday.size > 5000) seenToday.clear();
    seenToday.add(key);
    try {
      await getStore().set(SEEN, key, { day }, { createOnly: true });
    } catch (error) {
      const status = error?.upstreamErrorStatus || error?.code;
      if (["ALREADY_EXISTS", "FAILED_PRECONDITION"].includes(status)) return;
      throw error;
    }
    await bump({ active: 1 });
  }

  async function summary(days = 14) {
    const count = Math.min(Math.max(Number(days) || 14, 1), MAX_DAYS);
    const dates = Array.from({ length: count }, (_, index) =>
      activityDay(now() - index * 86_400_000),
    );
    const documents = await Promise.all(dates.map((date) => getStore().get(DAILY, date)));
    return dates.map((date, index) => {
      const data = documents[index]?.data || {};
      return Object.fromEntries([
        ["date", date],
        ...ACTIVITY_FIELDS.map((field) => [field, Number(data[field]) || 0]),
      ]);
    });
  }

  return Object.freeze({ bump, markActive, summary });
}

let shared = null;
export function getActivityService() {
  return (shared ||= createActivityService());
}
export function setActivityServiceForTests(service) {
  shared = service;
}

// Never blocks or breaks the request it counts.
export function recordActivity(fields) {
  void getActivityService()
    .bump(fields)
    .catch((error) => logSafeError("[Activity] count", error));
}
export function recordActiveUser(accountId) {
  void getActivityService()
    .markActive(accountId)
    .catch((error) => logSafeError("[Activity] active", error));
}
