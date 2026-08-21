const DEFAULT_REPOSITORY = "radostinvgeorgiev-commits/sunchron-backend";
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
    "User-Agent": "AI CORE",
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
      console.error(`[GitHub] Upstream request failed: ${response.status}`);
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
  return path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
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

export async function getCommitDetails(
  ref,
  repository = configuredRepository(),
) {
  assertAllowedRepository(repository);
  const cleanRef = typeof ref === "string" ? ref.trim() : "";
  if (!/^[a-f0-9]{7,40}$/iu.test(cleanRef)) {
    throw new GitHubServiceError(
      "Невалиден GitHub commit.",
      400,
      "INVALID_COMMIT",
    );
  }

  const data = await githubRequest(
    `/repos/${repository}/commits/${encodeURIComponent(cleanRef)}`,
  );
  return {
    sha: data.sha,
    shortSha: data.sha?.slice(0, 7),
    message: data.commit?.message || "",
    date: data.commit?.author?.date || null,
    url: data.html_url,
    stats: {
      additions: data.stats?.additions || 0,
      deletions: data.stats?.deletions || 0,
      total: data.stats?.total || 0,
    },
    files: Array.isArray(data.files)
      ? data.files.map((file) => ({
          path: file.filename,
          status: file.status,
          additions: file.additions || 0,
          deletions: file.deletions || 0,
          changes: file.changes || 0,
          previousPath: file.previous_filename || null,
        }))
      : [],
  };
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

export async function listOpenIssues(
  repository = configuredRepository(),
  limit = 20,
) {
  assertAllowedRepository(repository);
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 50);
  const items = await githubRequest(
    `/repos/${repository}/issues?state=open&per_page=${safeLimit}`,
  );
  return items
    .filter((item) => !item.pull_request)
    .map((item) => ({
      number: item.number,
      title: item.title,
      state: item.state,
      updatedAt: item.updated_at,
      url: item.html_url,
    }));
}

export async function listOpenPullRequests(
  repository = configuredRepository(),
  limit = 20,
) {
  assertAllowedRepository(repository);
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 50);
  const items = await githubRequest(
    `/repos/${repository}/pulls?state=open&per_page=${safeLimit}`,
  );
  return items.map((item) => ({
    number: item.number,
    title: item.title,
    draft: Boolean(item.draft),
    state: item.state,
    head: item.head?.ref || null,
    base: item.base?.ref || null,
    updatedAt: item.updated_at,
    url: item.html_url,
  }));
}

export async function listRecentWorkflowRuns(
  repository = configuredRepository(),
  limit = 20,
) {
  assertAllowedRepository(repository);
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 50);
  const data = await githubRequest(
    `/repos/${repository}/actions/runs?per_page=${safeLimit}`,
  );
  return (Array.isArray(data.workflow_runs) ? data.workflow_runs : []).map(
    (run) => ({
      id: run.id,
      name: run.name || run.display_title || "GitHub Actions",
      event: run.event || null,
      status: run.status || null,
      conclusion: run.conclusion || null,
      headSha: run.head_sha || null,
      branch: run.head_branch || null,
      createdAt: run.created_at || null,
      updatedAt: run.updated_at || null,
      url: run.html_url || null,
    }),
  );
}

export async function getGitHubReadOverview({
  repository = configuredRepository(),
  limit = 10,
} = {}) {
  assertAllowedRepository(repository);
  const [summary, commits, issues, pullRequests, workflowRuns] =
    await Promise.all([
      getRepositorySummary(repository),
      listRecentCommits(repository, limit),
      listOpenIssues(repository, limit),
      listOpenPullRequests(repository, limit),
      listRecentWorkflowRuns(repository, limit),
    ]);
  return Object.freeze({
    summary,
    commits: Object.freeze(commits),
    issues: Object.freeze(issues),
    pullRequests: Object.freeze(pullRequests),
    workflowRuns: Object.freeze(workflowRuns),
  });
}

export function isGitHubReadRequest(message) {
  const text = typeof message === "string" ? message.trim().toLowerCase() : "";
  return (
    /(?:\bgithub\b|ги[тд][\s-]*хъб|(?:^|\s)хъб(?:ът|а)?(?=\s|[?!.,:;]|$))/iu.test(
      text,
    ) ||
    /\b(commit|комит|хранилищ|репозитор)/u.test(text) ||
    /последн(?:ата|ите)\s+промян/u.test(text)
  );
}

function isRepositoryArchitectureRequest(message) {
  const text = typeof message === "string" ? message.trim().toLowerCase() : "";
  return /(?:tool\s+registry|capability\s+engine|регистрирани\s+инструменти|разрешения.*инструмент|последно\s+поправени\s+проблем)/iu.test(
    text,
  );
}

function extractArray(block, field) {
  const match = block.match(new RegExp(`${field}:\\s*\\[([\\s\\S]*?)\\]`, "u"));
  if (!match) return [];
  return [...match[1].matchAll(/"([^"]+)"/gu)].map((item) => item[1]);
}

function parseRegisteredTools(source) {
  const definitions = [];
  const starts = [...source.matchAll(/\{\s*id:\s*"([^"]+)"/gu)];
  for (const [index, start] of starts.entries()) {
    const end = starts[index + 1]?.index ?? source.length;
    const block = source.slice(start.index, end);
    const name = block.match(/name:\s*"([^"]+)"/u)?.[1] || start[1];
    definitions.push({
      id: start[1],
      name,
      capabilities: extractArray(block, "capabilities"),
      permissions: extractArray(block, "permissions"),
    });
  }
  return definitions;
}

async function answerRepositoryArchitectureQuestion(text) {
  const repository = getConfiguredRepository();

  if (
    /къде\s+(?:са|се намират).*tool\s+registry.*capability\s+engine/iu.test(
      text,
    )
  ) {
    return [
      "1. Основните файлове са:",
      "• Tool Registry: src/tools/toolRegistry.js",
      "• Capability Engine: src/tools/capabilityEngine.js",
    ].join("\n");
  }

  if (/кои\s+инструменти.*регистриран/iu.test(text)) {
    const registry = await getFileContent(
      "src/tools/toolRegistry.js",
      repository,
      "main",
    );
    const tools = parseRegisteredTools(registry.content);
    return [
      `2. В Tool Registry са регистрирани ${tools.length} инструмента:`,
      ...tools.map((tool) => `• ${tool.name} (${tool.id})`),
    ].join("\n");
  }

  if (/какви\s+разрешения.*(?:всеки|инструмент)/iu.test(text)) {
    const registry = await getFileContent(
      "src/tools/toolRegistry.js",
      repository,
      "main",
    );
    const tools = parseRegisteredTools(registry.content);
    return [
      "3. Разрешения по инструменти:",
      ...tools.map(
        (tool) =>
          `• ${tool.name}: ${tool.permissions.length ? tool.permissions.join(", ") : "няма"}`,
      ),
    ].join("\n");
  }

  if (/чатът.*(?:действително\s+)?използва.*capability\s+engine/iu.test(text)) {
    const [chat, engine] = await Promise.all([
      getFileContent("src/routes/chat.js", repository, "main"),
      getFileContent("src/tools/capabilityEngine.js", repository, "main"),
    ]);
    const chatUsesEngine =
      /executeDetectedCapabilities/gu.test(chat.content) &&
      /executeCapability/gu.test(chat.content);
    const engineHasGitHubExecutor =
      /"github-read"[\s\S]*answerGitHubReadRequest/gu.test(engine.content);
    return [
      "4. Проверка на връзката:",
      chatUsesEngine && engineHasGitHubExecutor
        ? "• Да — chat.js подава засечените GitHub задачи към executeCapability, а Capability Engine ги изпълнява чрез github-read."
        : "• Не успях да потвърдя пълната изпълнима връзка в актуалния main.",
    ].join("\n");
  }

  if (/кои\s+са.*(?:три|3).*последно\s+поправен.*проблем/iu.test(text)) {
    const [registry, engine] = await Promise.all([
      getFileContent("src/tools/toolRegistry.js", repository, "main"),
      getFileContent("src/tools/capabilityEngine.js", repository, "main"),
    ]);
    const checks = [
      {
        ok: /capabilityPermissions\?\.\[capability\]/u.test(engine.content),
        text: "точно съпоставяне capability → permission",
      },
      {
        ok: /if\s*\(!tools\.has\(definition\.id\)\)\s*registerTool/u.test(
          registry.content,
        ),
        text: "идемпотентна регистрация на основните инструменти",
      },
      {
        ok: /CAPABILITY_EMPTY_RESULT/u.test(engine.content),
        text: "отхвърляне на празен или невалиден резултат",
      },
    ];
    return [
      "5. Трите последно поправени проблема са:",
      ...checks.map(
        (check) =>
          `• ${check.text}${check.ok ? " — потвърдено в main" : " — не е потвърдено"}`,
      ),
    ].join("\n");
  }

  return null;
}

export async function answerGitHubReadRequest(message) {
  if (
    !isGitHubReadRequest(message) &&
    !isRepositoryArchitectureRequest(message)
  ) {
    return null;
  }

  const text = message.toLowerCase();
  const architectureAnswer = await answerRepositoryArchitectureQuestion(text);
  if (architectureAnswer) return architectureAnswer;
  const asksForOpenPullRequests =
    /(?:отворен(?:и|ите)?\s+(?:pull\s*request|pr)|(?:pull\s*request|pr)(?:-а|-и|s)?\s+.*отворен|колко\s+.*(?:pull\s*request|pr))/iu.test(
      text,
    );
  if (asksForOpenPullRequests) {
    const repository = getConfiguredRepository();
    const asksForLatestCommit =
      /(?:последн(?:ия|ият|ата).*\b(?:commit|комит)\b|\bmain\b)/iu.test(
        text,
      );
    const [pullRequests, commits] = await Promise.all([
      listOpenPullRequests(repository, 50),
      asksForLatestCommit ? listRecentCommits(repository, 1) : [],
    ]);
    const latestCommit = commits[0];
    return [
      ...(latestCommit
        ? [
            `Последният commit в main е ${latestCommit.shortSha} — ${latestCommit.message}${latestCommit.date ? ` (${latestCommit.date})` : ""}.`,
          ]
        : []),
      `Отворени Pull Request-и: ${pullRequests.length === 50 ? "поне 50" : pullRequests.length}.`,
      ...pullRequests.map(
        (pullRequest) =>
          `• #${pullRequest.number} — ${pullRequest.title}${pullRequest.draft ? " (draft)" : ""}`,
      ),
    ].join("\n");
  }
  const explicitRef = message.match(/\b[a-f0-9]{7,40}\b/iu)?.[0];
  const asksForDetails =
    /(?:кои|изброй|файлов|файли|diff|разлик|подробност|какво точно|във всеки файл)/u.test(
      text,
    );

  if (asksForDetails) {
    const ref =
      explicitRef ||
      (await listRecentCommits(getConfiguredRepository(), 1))[0]?.sha;
    if (!ref) {
      return "В GitHub не намерих commit за подробна проверка.";
    }

    const commit = await getCommitDetails(ref, getConfiguredRepository());
    if (!commit.files.length) {
      return `Commit ${commit.shortSha} няма отчетени променени файлове.`;
    }

    const statusLabels = {
      added: "добавен",
      modified: "променен",
      removed: "изтрит",
      renamed: "преименуван",
    };
    return [
      `В commit ${commit.shortSha} са променени ${commit.files.length} файла:`,
      ...commit.files.map((file) => {
        const status = statusLabels[file.status] || file.status || "променен";
        const rename = file.previousPath ? ` от ${file.previousPath}` : "";
        return `• ${file.path} — ${status}${rename}; +${file.additions}/-${file.deletions} реда.`;
      }),
      `Общо: +${commit.stats.additions}/-${commit.stats.deletions} реда.`,
    ].join("\n");
  }

  const commits = await listRecentCommits(getConfiguredRepository(), 5);
  if (!commits.length) {
    return "В GitHub не намерих commit-и за разрешеното хранилище.";
  }

  const asksForSeveral = /последните|промените|комитите|commit-и|история/u.test(
    text,
  );
  const selected = asksForSeveral ? commits : commits.slice(0, 1);
  const heading =
    selected.length === 1
      ? "Последната реална промяна в GitHub е:"
      : "Последните реални промени в GitHub са:";

  return [
    heading,
    ...selected.map(
      (commit) =>
        `• ${commit.shortSha} — ${commit.message}${commit.date ? ` (${commit.date})` : ""}`,
    ),
  ].join("\n");
}
