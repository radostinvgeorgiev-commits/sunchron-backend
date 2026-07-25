import test from "node:test";
import assert from "node:assert/strict";
import {
  answerGitHubReadRequest,
  getCommitDetails,
  getFileContent,
  getRepositorySummary,
  GitHubServiceError,
  listRecentCommits,
  isGitHubReadRequest,
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
  process.env.GITHUB_REPOSITORY =
    "radostinvgeorgiev-commits/sunchron-backend";
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
      description: "Synchron-X",
      updated_at: "2026-07-25T00:00:00Z",
      html_url:
        "https://github.com/radostinvgeorgiev-commits/sunchron-backend",
    });
  };

  const summary = await getRepositorySummary();
  assert.equal(summary.repository, process.env.GITHUB_REPOSITORY);
  assert.equal(summary.defaultBranch, "main");
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
  assert.equal(isGitHubReadRequest("Провери последните commit-и в GitHub"), true);
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
