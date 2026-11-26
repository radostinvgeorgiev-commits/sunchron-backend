import { activityDay } from "./activityService.js";

// Everyone who ever registered, counted from the sign-in provider itself
// (Identity Platform), so people from before the activity counters started
// are included. Only dates and counts leave this function: no names, emails
// or ids.

const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const PAGE = 500;
const MAX_ACCOUNTS = 5_000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// The same mailbox written differently: lower case, "+anything" dropped,
// and for Gmail the dots too (a.b+x@gmail.com is ab@gmail.com).
export function mailboxKey(email) {
  const text = String(email || "").trim().toLowerCase();
  const at = text.lastIndexOf("@");
  if (at < 1) return "";
  let local = text.slice(0, at).split("+")[0];
  let domain = text.slice(at + 1);
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") local = local.replaceAll(".", "");
  return local ? `${local}@${domain}` : "";
}

async function metadataToken(fetchImpl) {
  const response = await fetchImpl(METADATA_TOKEN_URL, {
    headers: { "Metadata-Flavor": "Google" },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || typeof payload?.access_token !== "string") {
    throw new Error("no runtime token");
  }
  return payload.access_token;
}

export async function summarizeRegisteredAccounts({
  env = process.env,
  fetchImpl = fetch,
  now = Date.now,
  token,
  ownerEmail,
} = {}) {
  const ownerKey = mailboxKey(ownerEmail);
  let ownerAccounts = 0;
  const project = String(env.IDENTITY_PLATFORM_PROJECT_ID || env.GOOGLE_CLOUD_PROJECT || "").trim();
  if (!project) return { available: false, reason: "Няма Identity Platform проект." };
  try {
    const accessToken = token || (await metadataToken(fetchImpl));
    const created = [];
    let lastSignIns = 0;
    for (let offset = 0; offset < MAX_ACCOUNTS; offset += PAGE) {
      const response = await fetchImpl(
        `https://identitytoolkit.googleapis.com/v1/projects/${encodeURIComponent(project)}/accounts:query`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ returnUserInfo: true, limit: String(PAGE), offset: String(offset) }),
        },
      );
      if (!response.ok) {
        return {
          available: false,
          reason: response.status === 403
            ? "Сървърът няма право да чете списъка с профили."
            : "Списъкът с профили временно не е достъпен.",
        };
      }
      const data = await response.json().catch(() => ({}));
      const users = Array.isArray(data.userInfo) ? data.userInfo : [];
      for (const user of users) {
        const at = Number(user?.createdAt);
        if (Number.isFinite(at) && at > 0) created.push(at);
        if (Number(user?.lastLoginAt) > now() - WEEK_MS) lastSignIns += 1;
        if (ownerKey && mailboxKey(user?.email) === ownerKey) ownerAccounts += 1;
      }
      if (users.length < PAGE) break;
    }
    const byDay = {};
    for (const at of created) {
      const day = activityDay(at);
      byDay[day] = (byDay[day] || 0) + 1;
    }
    const result = { available: true, total: created.length, signedInLast7Days: lastSignIns, byDay };
    if (ownerKey) {
      result.ownerAccounts = ownerAccounts;
      result.otherAccounts = Math.max(0, created.length - ownerAccounts);
    }
    return result;
  } catch {
    return { available: false, reason: "Списъкът с профили временно не е достъпен." };
  }
}
