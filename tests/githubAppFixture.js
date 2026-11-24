import { generateKeyPairSync } from "node:crypto";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

export function configureGitHubAppFixture() {
  process.env.GITHUB_APP_ID = "123";
  process.env.GITHUB_APP_INSTALLATION_ID = "456";
  process.env.GITHUB_APP_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" });
}

export function githubAppFetchFixture({ login = "radostinvgeorgiev-commits", token = "test-owner-token", repositories } = {}) {
  return async (url) => {
    if (String(url).endsWith("/user")) return Response.json({ login });
    if (String(url).endsWith("/app/installations/456/access_tokens")) {
      return Response.json({
        token,
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        repositories: repositories || [{ full_name: process.env.GITHUB_REPOSITORY || "radostinvgeorgiev-commits/sunchron-backend" }],
      });
    }
    throw new Error("Unexpected GitHub fixture request");
  };
}
