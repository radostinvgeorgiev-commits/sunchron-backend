import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

function validCommit(value) {
  const commit = typeof value === "string" ? value.trim() : "";
  return /^[0-9a-f]{7,40}$/iu.test(commit) ? commit : "";
}

function resolveCommit(env = process.env) {
  for (const name of [
    "APP_COMMIT_SHA",
    "SOURCE_COMMIT_HASH",
    "COMMIT_HASH",
    "GITHUB_SHA",
  ]) {
    const commit = validCommit(env[name]);
    if (commit) return commit;
  }

  try {
    return validCommit(
      execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
  } catch {
    return "";
  }
}

const buildInfo = {
  commit: resolveCommit() || "unknown",
  generatedAt: new Date().toISOString(),
};

writeFileSync(
  resolve("runtime-build-info.json"),
  `${JSON.stringify(buildInfo)}\n`,
  "utf8",
);
