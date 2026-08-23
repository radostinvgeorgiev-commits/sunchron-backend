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
    "User-Agent": "AI CORE",
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

function assertPullRequestNumber(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new GitHubServiceError(
      "Невалиден номер на GitHub Pull Request.",
      400,
      "INVALID_PULL_REQUEST_NUMBER",
    );
  }
  return number;
}

function assertCommitSha(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/iu.test(value.trim())) {
    throw new GitHubServiceError(
      "Липсва валиден точен head commit SHA на Pull Request-а.",
      400,
      "INVALID_PULL_REQUEST_SHA",
    );
  }
  return value.trim();
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

/**
 * Merges one owner-confirmed Pull Request after binding the exact head SHA
 * and verifying that GitHub reports successful checks and no known conflict.
 */
export async function getPullRequest({ repository, pullNumber, accessToken }) {
  const repo = repository ?? configuredRepository();
  assertAllowedRepository(repo);
  const number = assertPullRequestNumber(pullNumber);
  return githubWriteRequest(
    `/repos/${repo}/pulls/${number}`,
    {},
    accessToken,
  );
}

export async function mergePullRequest({
  repository,
  pullNumber,
  expectedHeadSha,
  expectedBaseSha,
  base = "main",
  mergeMethod = "merge",
  accessToken,
}) {
  const repo = repository ?? configuredRepository();
  assertAllowedRepository(repo);
  const number = assertPullRequestNumber(pullNumber);
  const headSha = assertCommitSha(expectedHeadSha);
  const baseSha = assertCommitSha(expectedBaseSha);

  if (base !== "main") {
    throw new GitHubServiceError(
      "Pull Request може да бъде сливан само към main.",
      403,
      "PROTECTED_BRANCH",
    );
  }
  if (!["merge", "squash", "rebase"].includes(mergeMethod)) {
    throw new GitHubServiceError(
      "Невалиден метод за сливане на Pull Request.",
      400,
      "INVALID_MERGE_METHOD",
    );
  }

  const pullRequest = await getPullRequest({
    repository: repo,
    pullNumber: number,
    accessToken,
  });
  if (pullRequest.merged) {
    return {
      number,
      merged: true,
      unchanged: true,
      mergeCommitSha: pullRequest.merge_commit_sha || null,
      url: pullRequest.html_url || null,
    };
  }
  if (pullRequest.state !== "open") {
    throw new GitHubServiceError(
      "Pull Request-ът не е отворен.",
      409,
      "PULL_REQUEST_NOT_OPEN",
    );
  }
  if (pullRequest.draft) {
    throw new GitHubServiceError(
      "Draft Pull Request не може да бъде слят.",
      409,
      "PULL_REQUEST_DRAFT",
    );
  }
  if (pullRequest.base?.ref !== base) {
    throw new GitHubServiceError(
      "Pull Request-ът не е насочен към защитения main.",
      403,
      "PROTECTED_BRANCH",
    );
  }
  if (pullRequest.base?.sha !== baseSha) {
    throw new GitHubServiceError(
      "Основата на Pull Request-а се е променила след подготовката. Направи ново потвърждение.",
      409,
      "PULL_REQUEST_BASE_CHANGED",
    );
  }
  if (pullRequest.head?.sha !== headSha) {
    throw new GitHubServiceError(
      "Head commit-ът се е променил след подготовката. Направи ново потвърждение.",
      409,
      "PULL_REQUEST_HEAD_CHANGED",
    );
  }
  if (
    pullRequest.mergeable === false ||
    ["dirty", "blocked"].includes(pullRequest.mergeable_state)
  ) {
    throw new GitHubServiceError(
      "GitHub отчита конфликт или блокирано сливане.",
      409,
      "PULL_REQUEST_NOT_MERGEABLE",
    );
  }

  const [combinedStatus, checkRuns] = await Promise.all([
    githubWriteRequest(
      `/repos/${repo}/commits/${encodeURIComponent(headSha)}/status`,
      {},
      accessToken,
    ),
    githubWriteRequest(
      `/repos/${repo}/commits/${encodeURIComponent(headSha)}/check-runs`,
      {},
      accessToken,
    ),
  ]);
  const combinedStatusGreen =
    !combinedStatus?.state || combinedStatus.state === "success";
  const runs = Array.isArray(checkRuns?.check_runs)
    ? checkRuns.check_runs
    : [];
  const checksGreen =
    runs.length > 0 &&
    runs.every(
      (run) =>
        run?.status === "completed" &&
        ["success", "neutral", "skipped"].includes(run?.conclusion),
    );
  if (!combinedStatusGreen || !checksGreen) {
    throw new GitHubServiceError(
      "CI проверките не са зелени. Pull Request-ът не е слят.",
      409,
      "PULL_REQUEST_CHECKS_NOT_GREEN",
    );
  }

  const result = await githubWriteRequest(
    `/repos/${repo}/pulls/${number}/merge`,
    {
      method: "PUT",
      body: JSON.stringify({
        sha: headSha,
        merge_method: mergeMethod,
      }),
    },
    accessToken,
  );
  if (!result.merged) {
    throw new GitHubServiceError(
      result.message || "GitHub не потвърди сливането на Pull Request-а.",
      409,
      "PULL_REQUEST_MERGE_FAILED",
    );
  }
  return {
    number,
    merged: true,
    unchanged: false,
    mergeCommitSha: result.sha || null,
    url: pullRequest.html_url || null,
    message: result.message || null,
  };
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

export async function createCodeTaskPullRequest({
  repository,
  branchName,
  base = "main",
  changes,
  commitMessage,
  title,
  body = "",
  accessToken,
}) {
  const repo = repository ?? configuredRepository();
  assertAllowedRepository(repo);
  const branch = assertWritableBranch(branchName);
  if (base !== "main") {
    throw new GitHubServiceError(
      "Кодовата задача може да започне само от защитения main.",
      403,
      "PROTECTED_BRANCH",
    );
  }
  if (!Array.isArray(changes) || changes.length < 1 || changes.length > 4) {
    throw new GitHubServiceError(
      "Кодовата задача трябва да съдържа между 1 и 4 файла.",
      400,
      "INVALID_CODE_TASK_CHANGES",
    );
  }
  const tree = changes.map((change) => {
    assertValidPath(change?.path);
    if (
      typeof change?.content !== "string" ||
      change.content.length > 100_000
    ) {
      throw new GitHubServiceError(
        "Невалидно съдържание в кодовата задача.",
        400,
        "INVALID_CODE_TASK_CONTENT",
      );
    }
    return {
      path: change.path,
      mode: "100644",
      type: "blob",
      content: change.content,
    };
  });

  const baseRef = await githubWriteRequest(
    `/repos/${repo}/git/ref/heads/${encodeURIComponent(base)}`,
    {},
    accessToken,
  );
  const baseSha = baseRef.object?.sha;
  if (!baseSha) {
    throw new GitHubServiceError(
      "GitHub не върна SHA на main.",
      502,
      "GITHUB_BASE_SHA_MISSING",
    );
  }
  const baseCommit = await githubWriteRequest(
    `/repos/${repo}/git/commits/${encodeURIComponent(baseSha)}`,
    {},
    accessToken,
  );
  const baseTreeSha = baseCommit.tree?.sha;
  if (!baseTreeSha) {
    throw new GitHubServiceError(
      "GitHub не върна дървото на main.",
      502,
      "GITHUB_BASE_TREE_MISSING",
    );
  }
  const createdTree = await githubWriteRequest(
    `/repos/${repo}/git/trees`,
    {
      method: "POST",
      body: JSON.stringify({ base_tree: baseTreeSha, tree }),
    },
    accessToken,
  );
  const commit = await githubWriteRequest(
    `/repos/${repo}/git/commits`,
    {
      method: "POST",
      body: JSON.stringify({
        message: commitMessage || "AI CORE code task",
        tree: createdTree.sha,
        parents: [baseSha],
      }),
    },
    accessToken,
  );
  await githubWriteRequest(
    `/repos/${repo}/git/refs`,
    {
      method: "POST",
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }),
    },
    accessToken,
  );
  const pullRequest = await createPullRequest({
    repository: repo,
    title,
    body,
    head: branch,
    base,
    accessToken,
  });
  return Object.freeze({
    repository: repo,
    branch,
    base,
    commitSha: commit.sha,
    pullRequestNumber: pullRequest.number,
    url: pullRequest.html_url,
    changedFiles: Object.freeze(tree.map(({ path }) => path)),
  });
}
