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

export function logSafeError(context, error) {
  console.error(context, safeErrorMetadata(error));
}
