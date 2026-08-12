import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  applySupabaseIdentityMigration,
  createIdentityPlatformMigrationClient,
  createPreservedIdentityMap,
  createSupabaseIdentityMigrationPlan,
  IdentityPlatformUserMigrationError,
} from "../src/services/identityPlatformUserMigrationService.js";

const MAX_SOURCE_BYTES = 32 * 1024 * 1024;

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function hasArgument(name) {
  return process.argv.includes(name);
}

function envValue(...names) {
  for (const name of names) {
    const value = String(process.env[name] || "").trim();
    if (value) return value;
  }
  return null;
}

async function loadSourceRows() {
  const sourcePath =
    argumentValue("--source-users") ||
    envValue("SUPABASE_USERS_EXPORT_PATH", "IDENTITY_USER_MIGRATION_SOURCE");
  if (!sourcePath) {
    throw new IdentityPlatformUserMigrationError(
      "Липсва private Supabase user export. Подай --source-users или SUPABASE_USERS_EXPORT_PATH.",
      "IDENTITY_USER_MIGRATION_SOURCE_REQUIRED",
    );
  }
  const source = await readFile(path.resolve(sourcePath));
  if (source.byteLength > MAX_SOURCE_BYTES) {
    throw new IdentityPlatformUserMigrationError(
      "Supabase user export надвишава безопасния лимит.",
      "IDENTITY_USER_MIGRATION_LIMIT_EXCEEDED",
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(source.toString("utf8"));
  } catch {
    throw new IdentityPlatformUserMigrationError(
      "Supabase user export не е валиден JSON.",
      "IDENTITY_USER_MIGRATION_SOURCE_INVALID",
    );
  } finally {
    source.fill(0);
  }
  return Array.isArray(parsed) ? parsed : parsed?.users;
}

async function writeIdentityMap(sourceRows) {
  const outputPath = argumentValue("--identity-map-out");
  if (!outputPath) {
    throw new IdentityPlatformUserMigrationError(
      "Apply изисква private identity map output.",
      "IDENTITY_USER_MIGRATION_MAP_REQUIRED",
    );
  }
  await writeFile(
    path.resolve(outputPath),
    `${JSON.stringify(createPreservedIdentityMap(sourceRows))}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
}

async function assertIdentityMapOutputAvailable() {
  const outputPath = argumentValue("--identity-map-out");
  if (!outputPath) {
    throw new IdentityPlatformUserMigrationError(
      "Apply изисква private identity map output.",
      "IDENTITY_USER_MIGRATION_MAP_REQUIRED",
    );
  }
  try {
    await access(path.resolve(outputPath));
  } catch {
    return;
  }
  throw new IdentityPlatformUserMigrationError(
    "Private identity map output вече съществува.",
    "IDENTITY_USER_MIGRATION_MAP_EXISTS",
  );
}

async function main() {
  const apply = hasArgument("--apply");
  const sourceRows = await loadSourceRows();
  const client = createIdentityPlatformMigrationClient({});
  if (!apply) {
    console.log(
      JSON.stringify(
        createSupabaseIdentityMigrationPlan({
          sourceRows,
          targetUsers: await client.listUsers(),
        }),
      ),
    );
    return;
  }
  await assertIdentityMapOutputAvailable();
  const result = await applySupabaseIdentityMigration({
    sourceRows,
    client,
    confirmation: argumentValue("--confirmation"),
  });
  await writeIdentityMap(sourceRows);
  console.log(JSON.stringify({ ...result, identityMapWritten: true }));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    const code = error?.code || "IDENTITY_USER_MIGRATION_FAILED";
    const message = String(error?.message || "").trim();
    console.error(message ? `${code}: ${message}` : code);
    process.exitCode = 1;
  });
}
