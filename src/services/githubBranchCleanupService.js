import { createHash } from "node:crypto";
import { createDurableConfirmation } from "./confirmationService.js";
import { getLatestAuthorizedGitHubSession } from "./githubOAuthService.js";
import { GitHubServiceError } from "./githubService.js";

const DEFAULT_REPOSITORY = "radostinvgeorgiev-commits/sunchron-backend";
const DEFAULT_API_URL = "https://api.github.com";

function configuredRepository() {
  return (process.env.GITHUB_REPOSITORY || DEFAULT_REPOSITORY).trim();
}

function assertAllowedRepository(repository) {
  if (repository !== configuredRepository()) {
    throw new GitHubServiceError(
      "Това GitHub хранилище не е разрешено.",
      403,
      "REPOSITORY_NOT_ALLOWED",
    );
  }
}

async function requestGitHub(path, { accessToken, method = "GET" }, fetchImpl) {
  const apiUrl = (process.env.GITHUB_API_URL || DEFAULT_API_URL).replace(
    /\/+$/u,
    "",
  );
  const response = await fetchImpl(`${apiUrl}${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
    "User-Agent": "AI CORE",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok && response.status !== 204) {
    throw new GitHubServiceError(
      `GitHub върна грешка ${response.status}.`,
      response.status,
      "GITHUB_API_ERROR",
    );
  }
  return response.status === 204 ? null : response.json();
}

async function allPages(path, session, fetchImpl) {
  const items = [];
  for (let page = 1; page <= 20; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const batch = await requestGitHub(
      `${path}${separator}per_page=100&page=${page}`,
      session,
      fetchImpl,
    );
    items.push(...batch);
    if (batch.length < 100) break;
  }
  return items;
}

function branchFingerprint(branches) {
  return createHash("sha256").update(branches.join("\n")).digest("hex");
}

export function isMergedBranchCleanupPlanRequest(message) {
  const text = typeof message === "string" ? message.trim().toLowerCase() : "";
  if (!text) return false;
  const hasBranchTarget = /(?:github|гит[\s-]*хъб|клон|branch)/iu.test(text);
  const hasMergedConstraint = /(?:слет|merged|pull\s*request|\bpr\b)/iu.test(
    text,
  );
  const asksForSafePlan =
    /(?:подготви|покажи|намери|изброй|списък|провери|безопасн)/iu.test(text);
  const forbidsDeletion =
    /(?:не\s+изтривай|без\s+изтриване|нищо\s+не\s+изтривай)/iu.test(text);
  return (
    hasBranchTarget &&
    hasMergedConstraint &&
    (asksForSafePlan || forbidsDeletion)
  );
}

export async function prepareMergedBranchCleanup({
  ownerId,
  buildPlan = buildMergedBranchCleanupPlan,
  createConfirmation = createDurableConfirmation,
} = {}) {
  const cleanOwnerId =
    typeof ownerId === "string" && ownerId.trim() ? ownerId.trim() : "";
  if (!cleanOwnerId) {
    throw new GitHubServiceError(
      "Липсва удостоверен собственик за GitHub почистването.",
      401,
      "GITHUB_OWNER_REQUIRED",
    );
  }
  const plan = await buildPlan();
  const confirmation = await createConfirmation({
    sessionId: cleanOwnerId,
    action: "github.write:delete_merged_branches",
    resource: {
      repository: plan.repository,
      count: plan.count,
      fingerprint: plan.fingerprint,
    },
    params: { branchNames: plan.branchNames },
  });
  const branches = plan.branchNames.length
    ? plan.branchNames.map((name) => `• ${name}`)
    : ["• Няма клонове, които отговарят на всички защити."];
  return [
    `Намерени са ${plan.count} безопасни за изтриване клона от вече слети Pull Request-и:`,
    ...branches,
    "",
    "Нищо не е изтрито.",
    `За изтриване е нужно отделно еднократно потвърждение: ${confirmation.id}`,
  ].join("\n");
}

export async function buildMergedBranchCleanupPlan({
  repository = configuredRepository(),
  fetchImpl = fetch,
  getSession = getLatestAuthorizedGitHubSession,
} = {}) {
  assertAllowedRepository(repository);
  const session = await getSession();
  if (!session?.accessToken) {
    throw new GitHubServiceError(
      "Липсва активна GitHub owner сесия.",
      401,
      "GITHUB_OWNER_SESSION_REQUIRED",
    );
  }
  const encodedRepo = repository.split("/").map(encodeURIComponent).join("/");
  const [repo, branches, openPulls, closedPulls] = await Promise.all([
    requestGitHub(`/repos/${encodedRepo}`, session, fetchImpl),
    allPages(`/repos/${encodedRepo}/branches`, session, fetchImpl),
    allPages(`/repos/${encodedRepo}/pulls?state=open`, session, fetchImpl),
    allPages(`/repos/${encodedRepo}/pulls?state=closed`, session, fetchImpl),
  ]);
  const openHeads = new Set(openPulls.map((pull) => pull.head?.ref).filter(Boolean));
  const mergedHeads = new Set(
    closedPulls
      .filter((pull) => pull.merged_at && pull.head?.repo?.full_name === repository)
      .map((pull) => pull.head.ref),
  );
  const branchNames = branches
    .filter(
      (branch) =>
        branch.name !== repo.default_branch &&
        !branch.protected &&
        mergedHeads.has(branch.name) &&
        !openHeads.has(branch.name),
    )
    .map((branch) => branch.name)
    .sort();
  return {
    repository,
    defaultBranch: repo.default_branch,
    branchNames,
    count: branchNames.length,
    fingerprint: branchFingerprint(branchNames),
  };
}

export async function executeMergedBranchCleanup({
  repository,
  branchNames,
  fingerprint,
  fetchImpl = fetch,
  getSession = getLatestAuthorizedGitHubSession,
}) {
  const current = await buildMergedBranchCleanupPlan({
    repository,
    fetchImpl,
    getSession,
  });
  if (
    fingerprint !== branchFingerprint(branchNames) ||
    branchNames.some((name) => !current.branchNames.includes(name))
  ) {
    throw new GitHubServiceError(
      "Списъкът вече не е безопасен. Направи нова проверка.",
      409,
      "BRANCH_CLEANUP_PLAN_CHANGED",
    );
  }
  const session = await getSession();
  const encodedRepo = repository.split("/").map(encodeURIComponent).join("/");
  const deleted = [];
  for (const branch of branchNames) {
    await requestGitHub(
      `/repos/${encodedRepo}/git/refs/heads/${encodeURIComponent(branch)}`,
      { ...session, method: "DELETE" },
      fetchImpl,
    );
    deleted.push(branch);
  }
  return { repository, deleted, count: deleted.length };
}
