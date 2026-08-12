import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REQUIRED_SECRET_ENV = Object.freeze([
  "OPENAI_API_KEY",
  "GROK_API_KEY",
  "IDENTITY_PLATFORM_API_KEY",
  "USER_SESSION_ENCRYPTION_KEY",
  "GITHUB_SESSION_ENCRYPTION_KEY",
  "GOOGLE_SESSION_ENCRYPTION_KEY",
  "SYNCHRON_TEST_INVITE_CODE",
  "MCP_ACCESS_TOKEN",
  "MCP_OAUTH_SECRET",
]);
const SECRET_ALIASES = Object.freeze({
  OPENAI_API_KEY: "openai-api-key",
  GROK_API_KEY: "grok-api-key",
  IDENTITY_PLATFORM_API_KEY: "identity-platform-api-key",
  USER_SESSION_ENCRYPTION_KEY: "user-session-key",
  GITHUB_SESSION_ENCRYPTION_KEY: "github-session-key",
  GOOGLE_SESSION_ENCRYPTION_KEY: "google-session-key",
  SYNCHRON_TEST_INVITE_CODE: "tester-invite-code",
  MCP_ACCESS_TOKEN: "mcp-access-token",
  MCP_OAUTH_SECRET: "mcp-oauth-secret",
});

function verificationError(message, code = "GCP_STAGING_VERIFICATION_FAILED") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireValue(value, label) {
  const clean = String(value || "").trim();
  if (!clean) throw verificationError(`Липсва ${label}.`);
  return clean;
}

function envValue(...names) {
  for (const name of names) {
    const value = String(process.env[name] || "").trim();
    if (value) return value;
  }
  return null;
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function resolveCliOrEnv(flag, ...envNames) {
  return argumentValue(flag) || envValue(...envNames);
}

function containerEnvironment(description) {
  return new Map(
    (description?.spec?.template?.spec?.containers?.[0]?.env || []).map(
      (entry) => [entry.name, entry],
    ),
  );
}

export function verifyCloudRunDescription(
  description,
  { serviceName, expectedSha, projectId, region },
) {
  if (description?.metadata?.name !== serviceName) {
    throw verificationError("Cloud Run service името не съвпада.");
  }
  const revision = requireValue(
    description?.status?.latestReadyRevisionName,
    "ready Cloud Run revision",
  );
  const image = requireValue(
    description?.spec?.template?.spec?.containers?.[0]?.image,
    "Cloud Run image",
  );
  if (!/@sha256:[a-f0-9]{64}$/u.test(image)) {
    throw verificationError("Cloud Run revision не използва immutable digest.");
  }
  if (!image.startsWith(`${region}-docker.pkg.dev/${projectId}/`)) {
    throw verificationError(
      "Cloud Run image не е от очаквания Artifact Registry project/region.",
    );
  }
  const annotations = description?.metadata?.annotations || {};
  if (annotations["run.googleapis.com/ingress"] !== "all") {
    throw verificationError(
      "Частният staging трябва временно да допуска authenticated run.app acceptance.",
    );
  }
  const revisionAnnotations =
    description?.spec?.template?.metadata?.annotations || {};
  if (
    String(revisionAnnotations["autoscaling.knative.dev/minScale"]) !== "0" ||
    String(revisionAnnotations["autoscaling.knative.dev/maxScale"]) !== "2"
  ) {
    throw verificationError("Cloud Run staging scale границите не съвпадат.");
  }
  const env = containerEnvironment(description);
  const expectedValues = {
    APP_COMMIT_SHA: expectedSha,
    MEMORY_BACKEND: "firestore",
    PERSISTENCE_BACKEND: "firestore",
    AUTH_BACKEND: "identity-platform",
  };
  for (const [name, value] of Object.entries(expectedValues)) {
    if (env.get(name)?.value !== value) {
      throw verificationError(`Cloud Run ${name} не съвпада.`);
    }
  }
  for (const name of REQUIRED_SECRET_ENV) {
    const reference = env.get(name)?.valueFrom?.secretKeyRef;
    const version = String(reference?.key || "").trim();
    if (
      reference?.name !== SECRET_ALIASES[name] ||
      !/^[1-9][0-9]*$/u.test(version)
    ) {
      throw verificationError(`${name} не използва фиксирана secret версия.`);
    }
  }
  const serviceAccount = requireValue(
    description?.spec?.template?.spec?.serviceAccountName,
    "Cloud Run runtime service account",
  );
  if (!serviceAccount.endsWith(`@${projectId}.iam.gserviceaccount.com`)) {
    throw verificationError("Cloud Run service account е от друг project.");
  }
  return {
    revision,
    image,
    serviceAccount,
    url: (() => {
      const value = requireValue(
        description?.status?.url,
        "Cloud Run service URL",
      );
      if (!/^https:\/\/[a-z0-9.-]+\.run\.app$/u.test(value)) {
        throw verificationError("Cloud Run service URL е невалиден.");
      }
      return value;
    })(),
  };
}

export function verifyPrivateIamPolicy(policy = {}) {
  const publicMembers = new Set(["allUsers", "allAuthenticatedUsers"]);
  const exposed = (policy.bindings || []).some(
    (binding) =>
      binding.role === "roles/run.invoker" &&
      (binding.members || []).some((member) => publicMembers.has(member)),
  );
  if (exposed) {
    throw verificationError("Cloud Run staging има публичен invoker.");
  }
  return true;
}

export function verifyHealthPayload(payload, expectedSha) {
  if (payload?.status !== "ok" || payload?.commit !== expectedSha) {
    throw verificationError(
      "Cloud Run /health exact-SHA проверката е неуспешна.",
    );
  }
  return true;
}

export function verifyReadinessPayload(payload, expectedSha) {
  const memory = payload?.checks?.memory;
  const acceptance = payload?.checks?.memoryAcceptance;
  if (
    payload?.status !== "ready" ||
    payload?.commit !== expectedSha ||
    payload?.checks?.chatAgent?.ready !== true ||
    memory?.ready !== true ||
    memory?.backend !== "firestore" ||
    acceptance?.ready !== true ||
    acceptance?.passedSteps < 9 ||
    acceptance?.isolated !== true ||
    acceptance?.realMemoryUnchanged !== true ||
    acceptance?.cleanupCompleted !== true
  ) {
    throw verificationError("Cloud Run /health/ready acceptance е неуспешна.");
  }
  return true;
}

export function verifyAuthSessionPayload(payload) {
  if (
    payload?.configured !== true ||
    payload?.configuration?.projectConnection !== true ||
    payload?.configuration?.sessionProtection !== true ||
    payload?.registrationEnabled !== true ||
    payload?.authProvider !== "identity-platform" ||
    payload?.authenticated !== false
  ) {
    throw verificationError("Identity Platform staging readiness липсва.");
  }
  return true;
}

function runGcloud(args) {
  let executable = "gcloud";
  let commandArgs = args;
  if (process.platform === "win32") {
    const located = spawnSync("where.exe", ["gcloud.cmd"], {
      encoding: "utf8",
      windowsHide: true,
      shell: false,
    });
    const commandPath = String(located.stdout || "")
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find(Boolean);
    if (!commandPath) {
      throw verificationError("gcloud не е намерен.", "GCLOUD_NOT_FOUND");
    }
    const sdkRoot = path.dirname(path.dirname(commandPath));
    executable =
      process.env.CLOUDSDK_PYTHON ||
      path.join(sdkRoot, "platform", "bundledpython", "python.exe");
    commandArgs = [path.join(sdkRoot, "lib", "gcloud.py"), ...args];
  }
  const result = spawnSync(executable, commandArgs, {
    encoding: "utf8",
    windowsHide: true,
    shell: false,
  });
  if (result.status !== 0) {
    throw verificationError(
      `gcloud ${args.slice(0, 3).join(" ")} не завърши успешно.`,
      "GCLOUD_COMMAND_FAILED",
    );
  }
  return String(result.stdout || "").trim();
}

async function fetchJson(url, token, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw verificationError(`Staging endpoint върна HTTP ${response.status}.`);
  }
  return response.json();
}

async function main() {
  const project = requireValue(
    resolveCliOrEnv("--project", "GCP_PROJECT_ID", "GOOGLE_CLOUD_PROJECT"),
    "project (--project или GCP_PROJECT_ID)",
  );
  const region = requireValue(
    resolveCliOrEnv("--region", "GCP_REGION", "CLOUD_RUN_REGION"),
    "region (--region или GCP_REGION)",
  );
  const service = requireValue(
    resolveCliOrEnv("--service", "CLOUD_RUN_SERVICE", "GCP_CLOUD_RUN_SERVICE"),
    "service (--service или CLOUD_RUN_SERVICE)",
  );
  if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/u.test(project)) {
    throw verificationError("Project ID е невалиден.");
  }
  if (!/^[a-z]+-[a-z]+[0-9]$/u.test(region)) {
    throw verificationError("Region е невалиден.");
  }
  if (!/^[a-z][a-z0-9-]{0,47}[a-z0-9]$/u.test(service)) {
    throw verificationError("Service name е невалидно.");
  }
  const expectedSha = requireValue(
    resolveCliOrEnv("--expected-sha", "EXPECTED_SHA", "APP_COMMIT_SHA"),
    "expected SHA (--expected-sha или EXPECTED_SHA)",
  );
  if (!/^[a-f0-9]{40}$/u.test(expectedSha)) {
    throw verificationError("Expected SHA трябва да е пълен commit SHA.");
  }
  const activeAccount = runGcloud([
    "auth",
    "list",
    "--filter=status:ACTIVE",
    "--format=value(account)",
  ]);
  if (!activeAccount) {
    throw verificationError(
      "Няма активен gcloud акаунт.",
      "GCLOUD_AUTH_REQUIRED",
    );
  }
  const description = JSON.parse(
    runGcloud([
      "run",
      "services",
      "describe",
      service,
      `--project=${project}`,
      `--region=${region}`,
      "--format=json",
    ]),
  );
  const verified = verifyCloudRunDescription(description, {
    serviceName: service,
    expectedSha,
    projectId: project,
    region,
  });
  const policy = JSON.parse(
    runGcloud([
      "run",
      "services",
      "get-iam-policy",
      service,
      `--project=${project}`,
      `--region=${region}`,
      "--format=json",
    ]) || "{}",
  );
  verifyPrivateIamPolicy(policy);
  const token = runGcloud([
    "auth",
    "print-identity-token",
    `--audiences=${verified.url}`,
  ]);
  if (!token) throw verificationError("Не беше издаден Cloud Run ID token.");
  const [health, readiness, authSession] = await Promise.all([
    fetchJson(`${verified.url}/health`, token),
    fetchJson(`${verified.url}/health/ready`, token),
    fetchJson(`${verified.url}/api/auth/session`, token),
  ]);
  verifyHealthPayload(health, expectedSha);
  verifyReadinessPayload(readiness, expectedSha);
  verifyAuthSessionPayload(authSession);
  console.log(
    JSON.stringify({
      status: "accepted",
      service,
      revision: verified.revision,
      commit: expectedSha,
      imageDigestPinned: true,
      privateIam: true,
      memoryBackend: "firestore",
      memoryAcceptancePassedSteps:
        readiness.checks.memoryAcceptance.passedSteps,
      identityPlatformReady: true,
    }),
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    const code = error?.code || "GCP_STAGING_VERIFICATION_FAILED";
    const message = String(error?.message || "").trim();
    console.error(message ? `${code}: ${message}` : code);
    process.exitCode = 1;
  });
}
