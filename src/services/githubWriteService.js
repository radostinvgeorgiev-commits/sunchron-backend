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

function requireToken(accessToken) {
  const token =
    typeof accessToken === "string" && accessToken.trim()
      ? accessToken.trim()
      : process.env.GITHUB_TOKEN;
  if (!token) {
    throw new GitHubServiceError(
      "Липсва потвърдена GitHub сесия за запис.",
      500,
      "GITHUB_TOKEN_MISSING",
    );
  }
  return token;
}

function githubWriteHeaders(accessToken) {
  const token = requireToken(accessToken);
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "Synchron-X",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
    Authorization: `token ${token}`,
  };
}

async function githubWriteRequest(path, options = {}, accessToken) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  const apiUrl = (process.env.GITHUB_API_URL || DEFAULT_API_URL).replace(
    /\/+$/u,
    "",
  );

  try {
    const response = await fetch(`${apiUrl}${path}`, {
      headers: githubWriteHeaders(accessToken),
      signal: controller.signal,
      ...options,
    });

    if (!response.ok) {
      console.error(
        `[GitHub Write] Upstream request failed: ${response.status}`,
      );
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
  return path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

function assertValidPath(path) {
  if (!path || typeof path !== "string" || path.includes("..")) {
    throw new GitHubServiceError("Невалиден път.", 400, "INVALID_PATH");
  }
  if (
    path === ".env" ||
    path.startsWith(".env.") ||
    path.startsWith(".github/workflows/") ||
    path === ".do/app.yaml"
  ) {
    throw new GitHubServiceError(
      "Този чувствителен файл не може да се променя от AI CORE.",
      403,
      "PROTECTED_PATH",
    );
  }
}

function assertWritableBranch(branch) {
  const clean = typeof branch === "string" ? branch.trim() : "";
  if (
    !clean ||
    clean === "main" ||
    !/^[\w.\-/]+$/u.test(clean) ||
    clean.includes("..") ||
    clean.includes("@{") ||
    clean.includes("//") ||
    clean.startsWith("/") ||
    clean.startsWith(".") ||
    clean.endsWith("/") ||
    clean.endsWith(".") ||
    clean.endsWith(".lock")
  ) {
    throw new GitHubServiceError(
      "GitHub записът е разрешен само в отделен валиден клон, не в main.",
      403,
      "PROTECTED_BRANCH",
    );
  }
  return clean;
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
  accessToken,
}) {
  assertAllowedRepository(repository ?? configuredRepository());
  assertValidPath(path);
  const writableBranch = assertWritableBranch(branch);

  return githubWriteRequest(
    `/repos/${repository ?? configuredRepository()}/contents/${encodePath(path)}`,
    {
      method: "PUT",
      body: JSON.stringify({
        message: message || `Create ${path}`,
        content: Buffer.from(content ?? "", "utf8").toString("base64"),
        branch: writableBranch,
      }),
    },
    accessToken,
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
  accessToken,
}) {
  assertAllowedRepository(repository ?? configuredRepository());
  assertValidPath(path);
  const writableBranch = assertWritableBranch(branch);

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
        branch: writableBranch,
      }),
    },
    accessToken,
  );
}

/**
 * Creates a new branch from an existing one.
 */
export async function createBranch({
  repository,
  branchName,
  fromBranch = "main",
  accessToken,
}) {
  const repo = repository ?? configuredRepository();
  assertAllowedRepository(repo);

  const writableBranch = assertWritableBranch(branchName);
  if (fromBranch !== "main") {
    throw new GitHubServiceError(
      "Нов клон може да започне само от защитения main и не може да се казва main.",
      403,
      "PROTECTED_BRANCH",
    );
  }

  const refData = await githubWriteRequest(
    `/repos/${repo}/git/ref/heads/${encodeURIComponent(fromBranch)}`,
    {},
    accessToken,
  );
  const sha = refData.object?.sha;
  if (!sha) {
    throw new GitHubServiceError(
      `Клонът "${fromBranch}" не е намерен.`,
      404,
      "BRANCH_NOT_FOUND",
    );
  }

  return githubWriteRequest(
    `/repos/${repo}/git/refs`,
    {
      method: "POST",
      body: JSON.stringify({ ref: `refs/heads/${writableBranch}`, sha }),
    },
    accessToken,
  );
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
  accessToken,
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
  const writableHead = assertWritableBranch(head);
  if (base !== "main") {
    throw new GitHubServiceError(
      "Pull Request може да е насочен само към main.",
      403,
      "PROTECTED_BRANCH",
    );
  }

  return githubWriteRequest(
    `/repos/${repo}/pulls`,
    {
      method: "POST",
      body: JSON.stringify({ title, body, head: writableHead, base }),
    },
    accessToken,
  );
}

export async function closeIssue({ repository, issueNumber, accessToken }) {
  const repo = repository ?? configuredRepository();
  assertAllowedRepository(repo);
  const number = Number(issueNumber);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new GitHubServiceError(
      "Невалиден номер на GitHub issue.",
      400,
      "INVALID_ISSUE_NUMBER",
    );
  }
  const issue = await githubWriteRequest(
    `/repos/${repo}/issues/${number}`,
    {},
    accessToken,
  );
  if (issue.pull_request) {
    throw new GitHubServiceError(
      "Pull Request не може да бъде затворен през инструмента за issues.",
      403,
      "PULL_REQUEST_NOT_ALLOWED",
    );
  }
  if (issue.state === "closed")
    return { number, state: "closed", unchanged: true };
  const updated = await githubWriteRequest(
    `/repos/${repo}/issues/${number}`,
    {
      method: "PATCH",
      body: JSON.stringify({ state: "closed" }),
    },
    accessToken,
  );
  return {
    number: updated.number,
    state: updated.state,
    url: updated.html_url || null,
    unchanged: false,
  };
}
