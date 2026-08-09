import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REQUIRED_SECRETS = Object.freeze([
  "OPENAI_API_KEY",
  "IDENTITY_PLATFORM_API_KEY",
  "USER_SESSION_ENCRYPTION_KEY",
  "GITHUB_SESSION_ENCRYPTION_KEY",
  "GOOGLE_SESSION_ENCRYPTION_KEY",
  "SYNCHRON_TEST_INVITE_CODE",
  "MCP_ACCESS_TOKEN",
  "MCP_OAUTH_SECRET",
]);

const SECRET_PLACEHOLDERS = Object.freeze({
  OPENAI_API_KEY: "OPENAI_API_KEY",
  IDENTITY_PLATFORM_API_KEY: "IDENTITY_PLATFORM_API_KEY",
  USER_SESSION_ENCRYPTION_KEY: "USER_SESSION_ENCRYPTION_KEY",
  GITHUB_SESSION_ENCRYPTION_KEY: "GITHUB_SESSION_ENCRYPTION_KEY",
  GOOGLE_SESSION_ENCRYPTION_KEY: "GOOGLE_SESSION_ENCRYPTION_KEY",
  SYNCHRON_TEST_INVITE_CODE: "SYNCHRON_TEST_INVITE_CODE",
  MCP_ACCESS_TOKEN: "MCP_ACCESS_TOKEN",
  MCP_OAUTH_SECRET: "MCP_OAUTH_SECRET",
});

function configurationError(message) {
  const error = new Error(message);
  error.code = "GCP_STAGING_CONFIGURATION_INVALID";
  return error;
}

function requirePattern(value, pattern, label) {
  const clean = String(value || "").trim();
  if (!pattern.test(clean)) throw configurationError(`Невалиден ${label}.`);
  return clean;
}

function normalizeMcpResourceUrl(value, serviceName) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw configurationError("Невалиден MCP staging resource URL.");
  }
  if (
    url.protocol !== "https:" ||
    url.pathname !== "/mcp" ||
    !url.hostname.startsWith(`${serviceName}-`) ||
    !url.hostname.endsWith(".run.app") ||
    url.search ||
    url.hash
  ) {
    throw configurationError("Невалиден MCP staging resource URL.");
  }
  return {
    resourceUrl: url.href.replace(/\/$/u, ""),
    issuerUrl: url.origin,
  };
}

function normalizeSecret(secret, label) {
  const name = requirePattern(
    secret?.name,
    /^[A-Za-z0-9_-]{1,255}$/u,
    `${label} Secret Manager име`,
  );
  const version = requirePattern(
    secret?.version,
    /^[1-9][0-9]*$/u,
    `${label} фиксирана secret версия`,
  );
  return { name, version };
}

export function validateStagingConfiguration(input = {}) {
  const projectId = requirePattern(
    input.projectId,
    /^[a-z][a-z0-9-]{4,61}[a-z0-9]$/u,
    "Google Cloud project ID",
  );
  const projectNumber = requirePattern(
    input.projectNumber,
    /^[1-9][0-9]{5,19}$/u,
    "Google Cloud project number",
  );
  const region = requirePattern(
    input.region,
    /^[a-z]+-[a-z]+[0-9]$/u,
    "Google Cloud region",
  );
  const serviceName = requirePattern(
    input.serviceName,
    /^[a-z][a-z0-9-]{0,47}[a-z0-9]$/u,
    "Cloud Run service name",
  );
  const serviceAccount = requirePattern(
    input.serviceAccount,
    /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,61}[a-z0-9]\.iam\.gserviceaccount\.com$/u,
    "Cloud Run service account",
  );
  if (!serviceAccount.endsWith(`@${projectId}.iam.gserviceaccount.com`)) {
    throw configurationError(
      "Cloud Run service account трябва да е от избрания project.",
    );
  }
  const commitSha = requirePattern(
    input.commitSha,
    /^[a-f0-9]{40}$/u,
    "exact commit SHA",
  );
  const imageUri = String(input.imageUri || "").trim();
  const imagePrefix = `${region}-docker.pkg.dev/${projectId}/`;
  if (
    !imageUri.startsWith(imagePrefix) ||
    !/@sha256:[a-f0-9]{64}$/u.test(imageUri)
  ) {
    throw configurationError(
      "Cloud Run image трябва да е Artifact Registry digest от избрания project/region.",
    );
  }
  const memoryOwnerId = requirePattern(
    input.memoryOwnerId,
    /^[A-Za-z0-9:_.-]{3,120}$/u,
    "изолиран staging memory owner",
  );
  const { resourceUrl: mcpResourceUrl, issuerUrl: mcpIssuerUrl } =
    normalizeMcpResourceUrl(input.mcpResourceUrl, serviceName);
  const secrets = Object.fromEntries(
    REQUIRED_SECRETS.map((name) => [
      name,
      normalizeSecret(input.secrets?.[name], name),
    ]),
  );

  return Object.freeze({
    projectId,
    projectNumber,
    region,
    serviceName,
    serviceAccount,
    imageUri,
    commitSha,
    memoryOwnerId,
    mcpResourceUrl,
    mcpIssuerUrl,
    secrets: Object.freeze(secrets),
  });
}

export function renderCloudRunService(template, input) {
  const configuration = validateStagingConfiguration(input);
  const replacements = {
    CLOUD_RUN_SERVICE_NAME: configuration.serviceName,
    CLOUD_RUN_RUNTIME_SERVICE_ACCOUNT: configuration.serviceAccount,
    ARTIFACT_REGISTRY_IMAGE_URI: configuration.imageUri,
    COMMIT_SHA: configuration.commitSha,
    GCP_PROJECT_ID: configuration.projectId,
    GCP_PROJECT_NUMBER: configuration.projectNumber,
    MEMORY_OWNER_ID: configuration.memoryOwnerId,
    MCP_RESOURCE_URL: configuration.mcpResourceUrl,
    MCP_ISSUER_URL: configuration.mcpIssuerUrl,
  };
  for (const [name, prefix] of Object.entries(SECRET_PLACEHOLDERS)) {
    replacements[`${prefix}_SECRET`] = configuration.secrets[name].name;
    replacements[`${prefix}_VERSION`] = configuration.secrets[name].version;
  }
  // The OAuth secret uses NAME to avoid the ambiguous *_SECRET_SECRET label.
  replacements.MCP_OAUTH_SECRET_NAME =
    configuration.secrets.MCP_OAUTH_SECRET.name;

  const rendered = String(template).replace(
    /__([A-Z0-9_]+)__/gu,
    (placeholder, name) => replacements[name] ?? placeholder,
  );
  const unresolved = [...rendered.matchAll(/__([A-Z0-9_]+)__/gu)].map(
    (match) => match[1],
  );
  if (unresolved.length) {
    throw configurationError(
      `Нерешени Cloud Run placeholders: ${[...new Set(unresolved)].join(", ")}.`,
    );
  }
  if (/\bkey:\s*["']?latest\b/iu.test(rendered)) {
    throw configurationError(
      "Cloud Run secret версиите не могат да са latest.",
    );
  }
  return rendered;
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

async function main() {
  const configPath = path.resolve(
    argumentValue("--config") || "deploy/cloud-run/staging.config.json",
  );
  const templatePath = path.resolve(
    argumentValue("--template") || "deploy/cloud-run/service.yaml.template",
  );
  const outputPath = path.resolve(
    argumentValue("--output") || "deploy/cloud-run/staging.rendered.yaml",
  );
  const [template, configurationText] = await Promise.all([
    readFile(templatePath, "utf8"),
    readFile(configPath, "utf8"),
  ]);
  const rendered = renderCloudRunService(
    template,
    JSON.parse(configurationText),
  );
  await writeFile(outputPath, rendered, { encoding: "utf8", flag: "wx" });
  console.log(`Cloud Run staging manifest е създаден: ${outputPath}`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error?.code || "GCP_STAGING_RENDER_FAILED");
    process.exitCode = 1;
  });
}
