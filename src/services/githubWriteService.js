import { GitHubServiceError } from "./githubService.js";

const DEFAULT_REPOSITORY = "radostinvgeorgiev-commits/sunchron-backend";
const DEFAULT_API_URL = "https://api.github.com";
const DEFAULT_TIMEOUT_MS = 10000;

function configuredRepository() {
  return (process.env.GITHUB_REPOSITORY || DEFAULT_REPOSITORY).trim();
}

function assertAllowedRepository(repository) {
  const allowed = configuredRepository();
  if (repository !== allowed) {
    throw new GitHubServiceError(
      "Това GitHub хранилище не е разрешено.",
      403,
      "REPOSITORY_NOT_ALLOWED",
    );
  }
}

function requireToken() {
  if (!process.env.GITHUB_TOKEN) {
    throw new GitHubServiceError(
      "GITHUB_TOKEN не е конфигуриран. Записът в GitHub не е възможен.",
      500,
      "GITHUB_TOKEN_MISSING",
    );
  }
  return process.env.GITHUB_TOKEN;
}

function githubWriteHeaders() {
  const token = requireToken();
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "Synchron-X",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
    Authorization: `token ${token}`,
  };
}

async function githubWriteRequest(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  const apiUrl = (process.env.GITHUB_API_URL || DEFAULT_API_URL).replace(
    /\/+$/u,
    "",
  );

  try {
    const response = await fetch(`${apiUrl}${path}`, {
      headers: githubWriteHeaders(),
      signal: controller.signal,
      ...options,
    });

    if (!response.ok) {
      const details = await response.text();
      console.error(`[GitHub Write] ${response.status}:`, details || "<empty>");
      throw new GitHubServiceError(
        `GitHub върна грешка ${response.status}.`,
        response.status,
        "GITHUB_API_ERROR",
      );
    }
    return response.json();
  } catch (error) {
    if (error instanceof GitHubServiceError) throw error;
    if (error?.name === "AbortError") {
      throw new GitHubServiceError(
        "GitHub не отговори навреме.",
        504,
        "GITHUB_TIMEOUT",
      );
    }
    throw new GitHubServiceError(
      "Връзката с GitHub не е достъпна.",
      503,
      "GITHUB_UNAVAILABLE",
    );
  } finally {
    clearTimeout(timeout);
  }
}

function encodePath(path) {
  return path
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
}

function assertValidPath(path) {
  if (!path || typeof path !== "string" || path.includes("..")) {
    throw new GitHubServiceError("Невалиден път.", 400, "INVALID_PATH");
  }
}

/**
 * Creates a new file in a repository branch.
 */
export async function createFile({
  repository,
  branch,
  path,
  content,
  message,
}) {
  assertAllowedRepository(repository ?? configuredRepository());
  assertValidPath(path);

  return githubWriteRequest(
    `/repos/${repository ?? configuredRepository()}/contents/${encodePath(path)}`,
    {
      method: "PUT",
      body: JSON.stringify({
        message: message || `Create ${path}`,
        content: Buffer.from(content ?? "", "utf8").toString("base64"),
        branch,
      }),
    },
  );
}

/**
 * Updates an existing file in a repository branch.
 * Requires the current file SHA to prevent accidental overwrites.
 */
export async function updateFile({
  repository,
  branch,
  path,
  content,
  message,
  sha,
}) {
  assertAllowedRepository(repository ?? configuredRepository());
  assertValidPath(path);

  if (!sha || typeof sha !== "string") {
    throw new GitHubServiceError(
      "Липсва SHA на файла за обновяване.",
      400,
      "MISSING_SHA",
    );
  }

  return githubWriteRequest(
    `/repos/${repository ?? configuredRepository()}/contents/${encodePath(path)}`,
    {
      method: "PUT",
      body: JSON.stringify({
        message: message || `Update ${path}`,
        content: Buffer.from(content ?? "", "utf8").toString("base64"),
        sha,
        branch,
      }),
    },
  );
}

/**
 * Creates a new branch from an existing one.
 */
export async function createBranch({
  repository,
  branchName,
  fromBranch = "main",
}) {
  const repo = repository ?? configuredRepository();
  assertAllowedRepository(repo);

  if (!branchName || !/^[\w.\-/]+$/u.test(branchName)) {
    throw new GitHubServiceError(
      "Невалидно или липсващо име на клон.",
      400,
      "INVALID_BRANCH_NAME",
    );
  }

  const refData = await githubWriteRequest(
    `/repos/${repo}/git/ref/heads/${encodeURIComponent(fromBranch)}`,
  );
  const sha = refData.object?.sha;
  if (!sha) {
    throw new GitHubServiceError(
      `Клонът "${fromBranch}" не е намерен.`,
      404,
      "BRANCH_NOT_FOUND",
    );
  }

  return githubWriteRequest(`/repos/${repo}/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha }),
  });
}

/**
 * Opens a pull request.
 */
export async function createPullRequest({
  repository,
  title,
  body = "",
  head,
  base = "main",
}) {
  const repo = repository ?? configuredRepository();
  assertAllowedRepository(repo);

  if (!title || typeof title !== "string") {
    throw new GitHubServiceError(
      "Липсва заглавие за pull request.",
      400,
      "MISSING_TITLE",
    );
  }
  if (!head || typeof head !== "string") {
    throw new GitHubServiceError(
      "Липсва source клон (head) за pull request.",
      400,
      "MISSING_HEAD",
    );
  }

  return githubWriteRequest(`/repos/${repo}/pulls`, {
    method: "POST",
    body: JSON.stringify({ title, body, head, base }),
  });
}
