const DEFAULT_REPOSITORY =
  "radostinvgeorgiev-commits/sunchron-backend";
const DEFAULT_API_URL = "https://api.github.com";
const DEFAULT_TIMEOUT_MS = 10000;

export class GitHubServiceError extends Error {
  constructor(message, status = 500, code = "GITHUB_ERROR") {
    super(message);
    this.name = "GitHubServiceError";
    this.status = status;
    this.code = code;
  }
}

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

function githubHeaders() {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "Synchron-X",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  return headers;
}

async function githubRequest(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  const apiUrl = (process.env.GITHUB_API_URL || DEFAULT_API_URL).replace(
    /\/+$/u,
    "",
  );

  try {
    const response = await fetch(`${apiUrl}${path}`, {
      headers: githubHeaders(),
      signal: controller.signal,
      ...options,
    });
    if (!response.ok) {
      const details = await response.text();
      console.error(`[GitHub] ${response.status}:`, details || "<empty>");
      throw new GitHubServiceError(
        response.status === 404
          ? "GitHub ресурсът не е намерен."
          : `GitHub върна грешка ${response.status}.`,
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

export function getConfiguredRepository() {
  return configuredRepository();
}

export async function getRepositorySummary(
  repository = configuredRepository(),
) {
  assertAllowedRepository(repository);
  const data = await githubRequest(`/repos/${repository}`);
  return {
    repository: data.full_name,
    defaultBranch: data.default_branch,
    private: data.private,
    description: data.description,
    updatedAt: data.updated_at,
    url: data.html_url,
  };
}

export async function listRecentCommits(
  repository = configuredRepository(),
  limit = 5,
) {
  assertAllowedRepository(repository);
  const safeLimit = Math.min(Math.max(Number(limit) || 5, 1), 20);
  const commits = await githubRequest(
    `/repos/${repository}/commits?per_page=${safeLimit}`,
  );
  return commits.map((item) => ({
    sha: item.sha,
    shortSha: item.sha.slice(0, 7),
    message: item.commit?.message || "",
    author: item.commit?.author?.name || null,
    date: item.commit?.author?.date || null,
    url: item.html_url,
  }));
}

export async function getFileContent(
  path,
  repository = configuredRepository(),
  ref,
) {
  assertAllowedRepository(repository);
  const cleanPath = typeof path === "string" ? path.trim() : "";
  if (!cleanPath || cleanPath.includes("..")) {
    throw new GitHubServiceError(
      "Невалиден път към GitHub файл.",
      400,
      "INVALID_PATH",
    );
  }
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  const data = await githubRequest(
    `/repos/${repository}/contents/${encodePath(cleanPath)}${query}`,
  );
  if (data.type !== "file" || typeof data.content !== "string") {
    throw new GitHubServiceError(
      "Посоченият GitHub ресурс не е текстов файл.",
      422,
      "NOT_A_FILE",
    );
  }
  return {
    path: data.path,
    sha: data.sha,
    size: data.size,
    content: Buffer.from(data.content, "base64").toString("utf8"),
    url: data.html_url,
  };
}
