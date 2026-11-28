import test from "node:test";
import assert from "node:assert/strict";
import {
  answerGitHubItemStatus,
  answerGitHubReadRequest,
  getCommitDetails,
  getFileContent,
  getGitHubReadOverview,
  getRepositorySummary,
  GitHubServiceError,
  listRecentCommits,
  isGitHubReadRequest,
  pullRequestNumberOf,
} from "../src/services/githubService.js";

const originalFetch = global.fetch;
const originalRepository = process.env.GITHUB_REPOSITORY;
const originalApiUrl = process.env.GITHUB_API_URL;
const originalToken = process.env.GITHUB_TOKEN;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test.beforeEach(() => {
  process.env.GITHUB_REPOSITORY = "radostinvgeorgiev-commits/sunchron-backend";
  process.env.GITHUB_API_URL = "https://github.test";
  delete process.env.GITHUB_TOKEN;
});

test.afterEach(() => {
  global.fetch = originalFetch;
});

test.after(() => {
  if (originalRepository === undefined) delete process.env.GITHUB_REPOSITORY;
  else process.env.GITHUB_REPOSITORY = originalRepository;
  if (originalApiUrl === undefined) delete process.env.GITHUB_API_URL;
  else process.env.GITHUB_API_URL = originalApiUrl;
  if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = originalToken;
});

test("returns a repository summary in read-only mode", async () => {
  global.fetch = async (url, options) => {
    assert.equal(
      url,
      "https://github.test/repos/radostinvgeorgiev-commits/sunchron-backend",
    );
    assert.equal(options.headers.Authorization, undefined);
    return jsonResponse({
      full_name: "radostinvgeorgiev-commits/sunchron-backend",
      default_branch: "main",
      private: false,
      description: "NovariumAI",
      updated_at: "2026-07-25T00:00:00Z",
      html_url: "https://github.com/radostinvgeorgiev-commits/sunchron-backend",
    });
  };

  const summary = await getRepositorySummary();
  assert.equal(summary.repository, process.env.GITHUB_REPOSITORY);
  assert.equal(summary.defaultBranch, "main");
});

test("uses the owner OAuth token before the configured public read token", async () => {
  process.env.GITHUB_TOKEN = "configured-read-token";
  global.fetch = async (_url, options) => {
    assert.equal(options.headers.Authorization, "Bearer oauth-read-token");
    return jsonResponse({
      full_name: process.env.GITHUB_REPOSITORY,
      default_branch: "main",
      private: true,
      html_url: "https://github.test/repository",
    });
  };

  const summary = await getRepositorySummary(undefined, {
    accessToken: "oauth-read-token",
  });
  assert.equal(summary.private, true);
});

test("preserves the configured GITHUB_TOKEN read contract", async () => {
  process.env.GITHUB_TOKEN = "configured-read-token";
  global.fetch = async (_url, options) => {
    assert.equal(options.headers.Authorization, "Bearer configured-read-token");
    return jsonResponse({
      full_name: process.env.GITHUB_REPOSITORY,
      default_branch: "main",
      private: false,
      html_url: "https://github.test/repository",
    });
  };

  await getRepositorySummary();
});

test("limits and normalizes recent commits", async () => {
  global.fetch = async (url) => {
    assert.match(url, /commits\?per_page=20$/u);
    return jsonResponse([
      {
        sha: "a07541e61e4e56af0ca41d3d6596b53cbc244081",
        commit: {
          message: "Fix memory",
          author: { name: "Codex", date: "2026-07-25T00:00:00Z" },
        },
        html_url: "https://github.test/commit/a07541e",
      },
    ]);
  };

  const commits = await listRecentCommits(undefined, 100);
  assert.equal(commits[0].shortSha, "a07541e");
  assert.equal(commits[0].message, "Fix memory");
});

test("returns one read-only overview for repository, commits, issues, PRs and Actions", async () => {
  global.fetch = async (url) => {
    const path = String(url);
    if (path.endsWith("/sunchron-backend")) {
      return jsonResponse({
        full_name: process.env.GITHUB_REPOSITORY,
        default_branch: "main",
        private: false,
        html_url: "https://github.test/repository",
      });
    }
    if (path.includes("/commits?")) {
      return jsonResponse([
        {
          sha: "a".repeat(40),
          commit: { message: "Проверен commit", author: {} },
          html_url: "https://github.test/commit",
        },
      ]);
    }
    if (path.includes("/issues?") && !path.includes("/pulls?")) {
      return jsonResponse([
        {
          number: 7,
          title: "Issue",
          state: "open",
          labels: [],
          html_url: "https://github.test/issue/7",
        },
        {
          number: 8,
          title: "PR masquerading as issue",
          pull_request: {},
        },
      ]);
    }
    if (path.includes("/pulls?")) {
      return jsonResponse([
        {
          number: 8,
          title: "Pull Request",
          state: "open",
          draft: false,
          head: { ref: "agent/test", sha: "b".repeat(40) },
          base: { ref: "main" },
          html_url: "https://github.test/pull/8",
        },
      ]);
    }
    if (path.includes("/actions/runs?")) {
      return jsonResponse({
        workflow_runs: [
          {
            id: 9,
            name: "CI",
            status: "completed",
            conclusion: "success",
            head_sha: "b".repeat(40),
            head_branch: "agent/test",
          },
        ],
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const overview = await getGitHubReadOverview({ limit: 5 });
  assert.equal(overview.summary.defaultBranch, "main");
  assert.equal(overview.commits.length, 1);
  assert.deepEqual(
    overview.issues.map((issue) => issue.number),
    [7],
  );
  assert.equal(overview.pullRequests[0].number, 8);
  assert.equal(overview.workflowRuns[0].conclusion, "success");
});

test("answers a combined latest-commit and open-PR count request", async () => {
  global.fetch = async (url) => {
    const path = String(url);
    if (path.includes("/commits?")) {
      return jsonResponse([
        {
          sha: "a28469cf1bea8d0f03f4da35658e0e9e6a2be4d5",
          commit: {
            message: "UI: avatar picker (#334)",
            author: { date: "2026-08-21T00:49:55Z" },
          },
          html_url: "https://github.test/commit/a28469c",
        },
      ]);
    }
    if (path.includes("/pulls?")) {
      return jsonResponse([
        {
          number: 325,
          title: "Добави Anthropic Claude към NovariumAI",
          state: "open",
          draft: false,
          head: { ref: "feature/claude" },
          base: { ref: "main" },
          html_url: "https://github.test/pull/325",
        },
        {
          number: 321,
          title: "Bump dependencies",
          state: "open",
          draft: true,
          head: { ref: "dependabot/npm" },
          base: { ref: "main" },
          html_url: "https://github.test/pull/321",
        },
      ]);
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const answer = await answerGitHubReadRequest(
    "Прочети реално GitHub. Кажи точния последен commit на main и колко отворени Pull Request-а има. Само четене.",
  );

  assert.match(answer, /Последният commit в main е a28469c/u);
  assert.match(answer, /Отворени Pull Request-и: 2/u);
  assert.match(answer, /#325/u);
  assert.match(answer, /#321.*\(draft\)/u);
});

test("returns changed files for a specific commit", async () => {
  global.fetch = async (url) => {
    assert.match(url, /commits\/3d6474b$/u);
    return jsonResponse({
      sha: "3d6474b18a070ccca57573dd5c7eff95207aba1e",
      commit: {
        message: "Merge pull request #9",
        author: { date: "2026-07-25T14:18:42Z" },
      },
      stats: { additions: 20, deletions: 3, total: 23 },
      files: [
        {
          filename: "src/services/githubService.js",
          status: "modified",
          additions: 20,
          deletions: 3,
          changes: 23,
        },
      ],
    });
  };

  const commit = await getCommitDetails("3d6474b");
  assert.equal(commit.files[0].path, "src/services/githubService.js");
  assert.equal(commit.stats.additions, 20);
});

test("rejects an invalid commit reference", async () => {
  await assert.rejects(
    () => getCommitDetails("../main"),
    (error) =>
      error instanceof GitHubServiceError && error.code === "INVALID_COMMIT",
  );
});

test("reads and decodes an allowed text file", async () => {
  global.fetch = async (url) => {
    assert.match(url, /contents\/src\/routes\/chat.js\?ref=main$/u);
    return jsonResponse({
      type: "file",
      path: "src/routes/chat.js",
      sha: "abc123",
      size: 5,
      content: Buffer.from("hello").toString("base64"),
      html_url: "https://github.test/file",
    });
  };

  const file = await getFileContent("src/routes/chat.js", undefined, "main");
  assert.equal(file.content, "hello");
});

test("rejects traversal and repositories outside the allowlist", async () => {
  await assert.rejects(
    () => getFileContent("../secret"),
    (error) =>
      error instanceof GitHubServiceError && error.code === "INVALID_PATH",
  );
  await assert.rejects(
    () => getRepositorySummary("someone/else"),
    (error) =>
      error instanceof GitHubServiceError &&
      error.code === "REPOSITORY_NOT_ALLOWED",
  );
});

test("does not hide GitHub API failures", async () => {
  global.fetch = async () => jsonResponse({ message: "Not Found" }, 404);
  await assert.rejects(
    () => getRepositorySummary(),
    (error) =>
      error instanceof GitHubServiceError &&
      error.status === 404 &&
      error.code === "GITHUB_API_ERROR",
  );
});

test("recognizes GitHub questions but ignores unrelated chat", () => {
  assert.equal(
    isGitHubReadRequest("Каква е последната промяна в проекта?"),
    true,
  );
  assert.equal(
    isGitHubReadRequest("Провери последните commit-и в GitHub"),
    true,
  );
  assert.equal(isGitHubReadRequest("Какво е времето във Варна?"), false);
});

test("answers a GitHub question with verified commit data", async () => {
  global.fetch = async () =>
    jsonResponse([
      {
        sha: "95f7207f884fe67ed31b9e4ba078c903aa41b6d3",
        commit: {
          message: "Add real read-only GitHub module",
          author: { name: "Codex", date: "2026-07-25T00:30:00Z" },
        },
        html_url: "https://github.test/commit/95f7207",
      },
    ]);

  const reply = await answerGitHubReadRequest(
    "Каква е последната промяна в проекта?",
  );
  assert.match(reply, /95f7207/u);
  assert.match(reply, /Add real read-only GitHub module/u);
});

test("answers a commit details question with changed files", async () => {
  global.fetch = async (url) => {
    assert.match(url, /commits\/3d6474b$/u);
    return jsonResponse({
      sha: "3d6474b18a070ccca57573dd5c7eff95207aba1e",
      commit: { message: "Merge pull request #9" },
      stats: { additions: 10, deletions: 2, total: 12 },
      files: [
        {
          filename: "src/services/githubService.js",
          status: "modified",
          additions: 10,
          deletions: 2,
          changes: 12,
        },
      ],
    });
  };

  const reply = await answerGitHubReadRequest(
    "Изброй файловете, променени в commit 3d6474b, и обясни какво е променено.",
  );
  assert.match(reply, /src\/services\/githubService\.js/u);
  assert.match(reply, /\+10\/-2/u);
});

test("answers each repository architecture check from main instead of repeating commits", async () => {
  const registrySource = `
    { id: "github-read", name: "GitHub Read",
      capabilities: ["code.read"], permissions: ["github.read"] },
    { id: "google-firestore-memory", name: "Google Cloud Memory",
      capabilities: ["memory.read"], permissions: ["memory.read", "memory.write"] }
  `;
  global.fetch = async (url) => {
    const path = String(url);
    if (path.includes("toolRegistry.js")) {
      return jsonResponse({
        type: "file",
        path: "src/tools/toolRegistry.js",
        sha: "registry",
        size: registrySource.length,
        content: Buffer.from(registrySource).toString("base64"),
      });
    }
    if (path.includes("capabilityEngine.js")) {
      const content =
        'const x = capabilityPermissions?.[capability]; "github-read": answerGitHubReadRequest; CAPABILITY_EMPTY_RESULT';
      return jsonResponse({
        type: "file",
        path: "src/tools/capabilityEngine.js",
        sha: "engine",
        size: content.length,
        content: Buffer.from(content).toString("base64"),
      });
    }
    if (path.includes("chat.js")) {
      const content = "executeDetectedCapabilities(executeCapability)";
      return jsonResponse({
        type: "file",
        path: "src/routes/chat.js",
        sha: "chat",
        size: content.length,
        content: Buffer.from(content).toString("base64"),
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const locations = await answerGitHubReadRequest(
    "Къде са Tool Registry и Capability Engine в GitHub?",
  );
  assert.match(locations, /src\/tools\/toolRegistry\.js/u);

  const tools = await answerGitHubReadRequest(
    "Кои инструменти са регистрирани в GitHub проекта?",
  );
  assert.match(tools, /GitHub Read/u);
  assert.match(tools, /Google Cloud Memory/u);

  const permissions = await answerGitHubReadRequest(
    "Какви разрешения изисква всеки инструмент в GitHub проекта?",
  );
  assert.match(permissions, /github\.read/u);
  assert.match(permissions, /memory\.write/u);

  const connection = await answerGitHubReadRequest(
    "Дали чатът действително използва Capability Engine в GitHub проекта?",
  );
  assert.match(connection, /Да — chat\.js/u);

  const fixes = await answerGitHubReadRequest(
    "Кои са трите последно поправени проблема в GitHub проекта?",
  );
  assert.match(fixes, /capability → permission/u);
  assert.match(fixes, /празен или невалиден резултат/u);
});

// Item 3 (RADKO, 28.11: „то това си работи от доста време“): „покажи PR
// 594“ answered with the latest commit since #328 (21.08.2026) removed the
// pull request reader.
const REPO = "https://github.test/repos/radostinvgeorgiev-commits/sunchron-backend";
const HEAD = "a".repeat(40);
function pullRequestApi({ checks = "ok" } = {}) {
  const urls = [];
  global.fetch = async (url) => {
    urls.push(url);
    if (url === `${REPO}/issues/594`) return jsonResponse({ number: 594, title: "Манифест", state: "closed", pull_request: {} });
    if (url === `${REPO}/issues/12`) {
      return jsonResponse({ number: 12, title: "Бутонът не работи", state: "open", html_url: "https://github.com/x/issues/12" });
    }
    if (url === `${REPO}/pulls/594`) {
      return jsonResponse({
        number: 594,
        title: "Манифест",
        state: "closed",
        merged: true,
        merged_at: "2026-11-28T04:40:00Z",
        head: { ref: "claude/manifest", sha: HEAD },
        base: { ref: "main" },
        html_url: "https://github.com/radostinvgeorgiev-commits/sunchron-backend/pull/594",
        additions: 12,
        deletions: 3,
        changed_files: 3,
      });
    }
    if (url === `${REPO}/pulls/594/files?per_page=100`) {
      return jsonResponse([
        { filename: "docs/MANIFESTO.md", status: "modified", additions: 10, deletions: 3 },
        { filename: "docs/NEW.md", status: "added", additions: 2, deletions: 0 },
        { filename: "docs/OLD2.md", previous_filename: "docs/OLD.md", status: "renamed", additions: 0, deletions: 0 },
      ]);
    }
    if (url === `${REPO}/commits/${HEAD}/check-runs?per_page=100`) {
      if (checks === "hidden") return jsonResponse({ message: "Forbidden" }, 403);
      return jsonResponse({
        check_runs: [
          { name: "test", status: "completed", conclusion: checks === "failed" ? "failure" : "success" },
          { name: "smoke", status: "completed", conclusion: "success" },
        ],
      });
    }
    throw new Error(`unexpected ${url}`);
  };
  return urls;
}

test("„покажи PR 594“ shows that pull request: its state, checks and files", async () => {
  pullRequestApi();
  for (const phrase of ["покажи PR 594", "pull request 594", "пул рекуест 594", "какво става с PR-а 594", "PR #594"]) {
    assert.equal(isGitHubReadRequest(phrase), true, phrase);
    const answer = await answerGitHubReadRequest(phrase);
    assert.equal(
      answer,
      [
        "PR #594 — Манифест",
        "Състояние: слят на 2026-11-28; claude/manifest → main (aaaaaaa).",
        "Проверки: 2 от 2 минаха.",
        "Променени файлове: 3, +12/-3 реда.",
        "• docs/MANIFESTO.md — променен; +10/-3 реда.",
        "• docs/NEW.md — добавен; +2/-0 реда.",
        "• docs/OLD2.md — преименуван от docs/OLD.md; +0/-0 реда.",
        "https://github.com/radostinvgeorgiev-commits/sunchron-backend/pull/594",
      ].join("\n"),
      phrase,
    );
  }
  for (const phrase of ["приложение 594", "spr 12", "покажи 594", "PR"]) assert.equal(pullRequestNumberOf(phrase), 0, phrase);
});

test("a pull request's failed or hidden checks are said as they are", async () => {
  pullRequestApi({ checks: "failed" });
  assert.match(await answerGitHubReadRequest("покажи PR 594"), /^Проверки: 1 от 2 не минаха \(test\)\.$/mu);
  pullRequestApi({ checks: "hidden" });
  assert.match(await answerGitHubReadRequest("покажи PR 594"), /^Проверки: не се виждат\.$/mu);
});

test("the status of a task or pull request by its number reads that item, not the latest commit", async () => {
  const urls = pullRequestApi();
  assert.equal(
    await answerGitHubItemStatus(12),
    ["GitHub задача #12 — Бутонът не работи", "Състояние: отворена.", "https://github.com/x/issues/12"].join("\n"),
  );
  assert.match(await answerGitHubItemStatus(594), /^PR #594 — Манифест\nСъстояние: слят на 2026-11-28;/u);
  assert.ok(!urls.some((url) => url.includes("/commits?")), urls.join("\n"));
  await assert.rejects(answerGitHubItemStatus(0), GitHubServiceError);
});
