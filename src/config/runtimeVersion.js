import { readFileSync } from "node:fs";

function readBuildCommit() {
  try {
    const file = new URL("../../runtime-build-info.json", import.meta.url);
    const buildInfo = JSON.parse(readFileSync(file, "utf8"));
    return typeof buildInfo.commit === "string" && buildInfo.commit.trim()
      ? buildInfo.commit.trim()
      : "unknown";
  } catch {
    return "unknown";
  }
}

const buildCommit = readBuildCommit();

export function resolveRuntimeVersion(env = process.env) {
  return {
    version: env.npm_package_version || "1.0.0",
    commit: env.APP_COMMIT_SHA || buildCommit,
  };
}
