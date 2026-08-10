import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { getOpenSearchClient } from "../src/config/opensearch.js";
import {
  applyOpenSearchToFirestoreMigration,
  createOpenSearchMigrationInventory,
  createOpenSearchToFirestorePlan,
  GcpDataMigrationError,
  normalizeMigrationIdentityMap,
} from "../src/services/gcpDataMigrationService.js";
import { createFirestoreDocumentStore } from "../src/services/firestoreDocumentStore.js";

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function hasArgument(name) {
  return process.argv.includes(name);
}

async function loadIdentityMap() {
  const file = argumentValue("--identity-map");
  const inline = String(
    process.env.SYNCHRON_IDENTITY_MIGRATION_MAP_JSON || "",
  ).trim();
  if (file && inline) {
    throw new GcpDataMigrationError(
      "Избери само един identity map source.",
      "GCP_DATA_MIGRATION_IDENTITY_MAP_INVALID",
    );
  }
  if (!file && !inline) return normalizeMigrationIdentityMap({});
  const text = file ? await readFile(path.resolve(file), "utf8") : inline;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new GcpDataMigrationError(
      "Identity migration map не е валиден JSON.",
      "GCP_DATA_MIGRATION_IDENTITY_MAP_INVALID",
    );
  }
  return normalizeMigrationIdentityMap(parsed);
}

async function main() {
  const apply = hasArgument("--apply");
  const plan = hasArgument("--plan") || apply;
  if (apply && hasArgument("--inventory")) {
    throw new GcpDataMigrationError(
      "Apply и inventory не могат да се комбинират.",
      "GCP_DATA_MIGRATION_CONFIGURATION_INVALID",
    );
  }
  const client = getOpenSearchClient();
  if (!client) {
    throw new GcpDataMigrationError(
      "OpenSearch source не е конфигуриран.",
      "GCP_DATA_MIGRATION_SOURCE_UNAVAILABLE",
    );
  }
  if (!plan) {
    console.log(
      JSON.stringify(await createOpenSearchMigrationInventory({ client })),
    );
    return;
  }
  const identityMap = await loadIdentityMap();
  if (!apply) {
    console.log(
      JSON.stringify(
        await createOpenSearchToFirestorePlan({ client, identityMap }),
      ),
    );
    return;
  }
  const result = await applyOpenSearchToFirestoreMigration({
    client,
    documentStore: createFirestoreDocumentStore(),
    identityMap,
    confirmation: argumentValue("--confirmation"),
  });
  console.log(JSON.stringify(result));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error?.code || "GCP_DATA_MIGRATION_FAILED");
    process.exitCode = 1;
  });
}
