import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

const context = new AsyncLocalStorage();
const safeCodes = new Set([
  "API_KEY_INVALID",
  "INVALID_API_KEY",
  "API_KEY_HTTP_REFERRER_BLOCKED",
  "API_KEY_SERVICE_BLOCKED",
  "INVALID_DOMAIN",
  "EMAIL_EXISTS",
  "WEAK_PASSWORD",
  "OPERATION_NOT_ALLOWED",
  "ADMIN_ONLY_OPERATION",
  "INVALID_PASSWORD",
  "INVALID_LOGIN_CREDENTIALS",
  "EMAIL_NOT_FOUND",
  "USER_DISABLED",
  "INVALID_ID_TOKEN",
  "USER_NOT_FOUND",
  "TOO_MANY_ATTEMPTS_TRY_LATER",
  "INTERNAL_ERROR",
  "SESSION_INCOMPLETE",
]);

export function authRequestContext(_req, res, next) {
  if (context.getStore()) return next();
  const requestId = randomUUID();
  res.setHeader("X-Request-ID", requestId);
  context.run(requestId, next);
}

export function logAuthStep(step, outcome, error) {
  const upstreamCode = error?.upstreamCode;
  console.info(
    JSON.stringify({
      event: "auth",
      step,
      outcome,
      identityPlatformCode: safeCodes.has(upstreamCode)
        ? upstreamCode
        : upstreamCode
          ? "OTHER"
          : null,
      requestId: context.getStore() || null,
    }),
  );
}
