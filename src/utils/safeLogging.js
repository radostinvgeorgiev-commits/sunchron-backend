const SAFE_ERROR_NAME = /^(?:Error|[A-Za-z][A-Za-z0-9]{0,47}Error)$/u;
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/u;

function safeIdentifier(value, pattern, fallback = null) {
  return typeof value === "string" && pattern.test(value) ? value : fallback;
}

function safeStatus(error) {
  const candidates = [
    error?.status,
    error?.statusCode,
    error?.meta?.statusCode,
    error?.response?.status,
  ];
  return candidates.find(
    (value) => Number.isInteger(value) && value >= 100 && value <= 599,
  );
}

export function safeErrorMetadata(error) {
  const metadata = {
    name: safeIdentifier(error?.name, SAFE_ERROR_NAME, "Error"),
  };
  const code = safeIdentifier(error?.code, SAFE_ERROR_CODE);
  const status = safeStatus(error);
  if (code) metadata.code = code;
  if (status) metadata.status = status;
  return Object.freeze(metadata);
}

export function safeErrorCode(error, fallback = "UNCLASSIFIED_ERROR") {
  return (
    safeIdentifier(error?.code, SAFE_ERROR_CODE) ||
    safeIdentifier(fallback, SAFE_ERROR_CODE, "UNCLASSIFIED_ERROR")
  );
}

export function logSafeError(context, error) {
  console.error(context, safeErrorMetadata(error));
}

const SECRET_KEY_PATTERN =
  /(authorization|token|secret|password|cookie|key|api[-_]?key)/iu;

function redactValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => [
        key,
        SECRET_KEY_PATTERN.test(key) ? "[REDACTED]" : redactValue(entryValue),
      ]),
    );
  }
  if (typeof value === "string" && value.length > 128) return "[REDACTED]";
  return value;
}

export function logStructuredEvent(event, fields = {}, { debug = false } = {}) {
  const payload = redactValue(fields);
  const line = { event, ...payload };
  if (debug) {
    console.info(event, line);
    return;
  }
  console.info(event, line);
}
