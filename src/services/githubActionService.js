import { createHash } from "node:crypto";

import {
  createDurableConfirmation,
  markDurableConfirmationUsed,
  validateDurableConfirmation,
} from "./confirmationService.js";
import {
  getConfiguredRepository,
  GitHubServiceError,
} from "./githubService.js";
import {
  closeIssue,
  createBranch,
  createFile,
  createPullRequest,
  updateFile,
} from "./githubWriteService.js";
import { isAuthorizedGitHubLogin } from "./githubOAuthService.js";
import { executeAuditedWriteAction } from "./permissionService.js";

const ACTIONS = Object.freeze({
  CREATE_BRANCH: "github.write:create_branch",
  CREATE_FILE: "github.write:create_file",
  UPDATE_FILE: "github.write:update_file",
  CREATE_PULL_REQUEST: "github.write:create_pr",
  CLOSE_ISSUE: "github.write:close_issue",
});
const OPERATION_ACTIONS = Object.freeze({
  create_branch: ACTIONS.CREATE_BRANCH,
  create_file: ACTIONS.CREATE_FILE,
  update_file: ACTIONS.UPDATE_FILE,
  create_pr: ACTIONS.CREATE_PULL_REQUEST,
  close_issue: ACTIONS.CLOSE_ISSUE,
});
const SAFE_BRANCH_PATTERN = /^[\w.\-/]+$/u;
const SAFE_SHA_PATTERN = /^[a-f0-9]{40}$/iu;
const SECRET_PATTERN =
  /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}|\bgh[pousr]_[A-Za-z0-9_]{20,})/u;

export class GitHubActionError extends Error {
  constructor(message, status = 400, code = "GITHUB_ACTION_INVALID") {
    super(message);
    this.name = "GitHubActionError";
    this.status = status;
    this.code = code;
  }
}

function cleanText(value, maxLength, label, { required = false } = {}) {
  const clean =
    typeof value === "string"
      ? value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim()
      : "";
  if ((required && !clean) || clean.length > maxLength) {
    throw new GitHubActionError(
      `Липсва валидно поле „${label}“.`,
      400,
      "GITHUB_ACTION_FIELD_INVALID",
    );
  }
  return clean;
}

function cleanBranch(value, label = "branch") {
  const branch = cleanText(value, 200, label, { required: true });
  if (
    !SAFE_BRANCH_PATTERN.test(branch) ||
    branch === "main" ||
    branch.includes("..") ||
    branch.includes("@{") ||
    branch.includes("//") ||
    branch.startsWith("/") ||
    branch.startsWith(".") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch.endsWith(".lock")
  ) {
    throw new GitHubActionError(
      "GitHub промяната трябва да е в отделен валиден клон, не в main.",
      403,
      "PROTECTED_BRANCH",
    );
  }
  return branch;
}

function cleanPath(value) {
  const path = cleanText(value, 500, "path", { required: true });
  if (path.includes("..") || path.startsWith("/")) {
    throw new GitHubActionError(
      "Невалиден GitHub path.",
      400,
      "GITHUB_PATH_INVALID",
    );
  }
  if (
    path === ".env" ||
    path.startsWith(".env.") ||
    path.startsWith(".github/workflows/") ||
    path === ".do/app.yaml"
  ) {
    throw new GitHubActionError(
      "Secrets, GitHub Actions и production конфигурацията не могат да се променят от AI CORE.",
      403,
      "GITHUB_PROTECTED_PATH",
    );
  }
  return path;
}

function cleanContent(value) {
  if (typeof value !== "string" || value.length > 100_000) {
    throw new GitHubActionError(
      "Файловото съдържание липсва или е над 100 KB.",
      400,
      "GITHUB_CONTENT_INVALID",
    );
  }
  if (SECRET_PATTERN.test(value)) {
    throw new GitHubActionError(
      "Открит е възможен секрет. GitHub промяната е блокирана.",
      403,
      "GITHUB_SECRET_BLOCKED",
    );
  }
  return value;
}

function fingerprint(label, value) {
  return createHash("sha256")
    .update(`${label}\0`)
    .update(cleanText(value, 400, label, { required: true }))
    .digest("hex");
}

function normalizeOperation(operation, input = {}) {
  const action = OPERATION_ACTIONS[operation];
  if (!action) {
    throw new GitHubActionError(
      "Неподдържана GitHub промяна.",
      400,
      "GITHUB_OPERATION_INVALID",
    );
  }
  const repository = getConfiguredRepository();

  if (operation === "create_branch") {
    return {
      action,
      resource: {
        repository,
        branchName: cleanBranch(input.branchName, "branchName"),
        fromBranch: "main",
      },
      params: {},
    };
  }
  if (operation === "create_file") {
    return {
      action,
      resource: {
        repository,
        branch: cleanBranch(input.branch),
        path: cleanPath(input.path),
      },
      params: {
        content: cleanContent(input.content),
        message:
          cleanText(input.message, 300, "commit message") || "Create file",
      },
    };
  }
  if (operation === "update_file") {
    const sha = cleanText(input.sha, 40, "file SHA", { required: true });
    if (!SAFE_SHA_PATTERN.test(sha)) {
      throw new GitHubActionError(
        "Невалиден SHA на GitHub файла.",
        400,
        "GITHUB_SHA_INVALID",
      );
    }
    return {
      action,
      resource: {
        repository,
        branch: cleanBranch(input.branch),
        path: cleanPath(input.path),
        sha,
      },
      params: {
        content: cleanContent(input.content),
        message:
          cleanText(input.message, 300, "commit message") || "Update file",
      },
    };
  }
  if (operation === "create_pr") {
    return {
      action,
      resource: {
        repository,
        head: cleanBranch(input.head, "head"),
        base: "main",
      },
      params: {
        title: cleanText(input.title, 240, "PR title", { required: true }),
        body: cleanText(input.body, 20_000, "PR body"),
      },
    };
  }

  const issueNumber = Number(input.issueNumber);
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
    throw new GitHubActionError(
      "Невалиден номер на GitHub issue.",
      400,
      "GITHUB_ISSUE_INVALID",
    );
  }
  return {
    action,
    resource: { repository, issueNumber },
    params: {},
  };
}

function assertGitHubSession(githubSession) {
  if (
    !githubSession?.accessToken ||
    !isAuthorizedGitHubLogin(githubSession.login)
  ) {
    throw new GitHubActionError(
      "Липсва потвърдена собственическа GitHub връзка.",
      401,
      "GITHUB_SESSION_REQUIRED",
    );
  }
  return githubSession;
}

export async function prepareGitHubChange(
  { ownerId, sessionId, githubSession, operation, input } = {},
  { createConfirmation = createDurableConfirmation } = {},
) {
  const session = assertGitHubSession(githubSession);
  const normalized = normalizeOperation(operation, input);
  const confirmation = await createConfirmation({
    sessionId,
    action: normalized.action,
    resource: {
      ...normalized.resource,
      ownerFingerprint: fingerprint("owner", ownerId),
      githubLoginFingerprint: fingerprint("github-login", session.login),
    },
    params: normalized.params,
  });
  return Object.freeze({
    confirmationId: confirmation.id,
    expiresAt: confirmation.expiresAt,
    operation,
    resource: Object.freeze({ ...normalized.resource }),
    params: Object.freeze({
      ...normalized.params,
      ...(normalized.params.content
        ? { content: `[${normalized.params.content.length} characters]` }
        : {}),
    }),
  });
}

export async function confirmGitHubChange(
  { ownerId, sessionId, confirmationId, githubSession } = {},
  {
    validateConfirmation = validateDurableConfirmation,
    consumeConfirmation = markDurableConfirmationUsed,
    executeWrite = executeAuditedWriteAction,
    adapters = {},
  } = {},
) {
  const session = assertGitHubSession(githubSession);
  const confirmation = await validateConfirmation(confirmationId, sessionId);
  if (!Object.values(ACTIONS).includes(confirmation.action)) {
    throw new GitHubActionError(
      "Потвърждението не е за GitHub промяна.",
      400,
      "GITHUB_ACTION_MISMATCH",
    );
  }
  if (
    confirmation.resource?.ownerFingerprint !== fingerprint("owner", ownerId)
  ) {
    throw new GitHubActionError(
      "Профилът не съответства на потвърдената GitHub промяна.",
      403,
      "GITHUB_OWNER_MISMATCH",
    );
  }
  if (
    confirmation.resource?.githubLoginFingerprint !==
    fingerprint("github-login", session.login)
  ) {
    throw new GitHubActionError(
      "GitHub профилът не съответства на потвърдената промяна.",
      403,
      "GITHUB_LOGIN_MISMATCH",
    );
  }

  await consumeConfirmation(confirmationId);
  const resource = confirmation.resource;
  const params = confirmation.params || {};
  const accessToken = session.accessToken;
  const createBranchAdapter = adapters.createBranch || createBranch;
  const createFileAdapter = adapters.createFile || createFile;
  const updateFileAdapter = adapters.updateFile || updateFile;
  const createPrAdapter = adapters.createPullRequest || createPullRequest;
  const closeIssueAdapter = adapters.closeIssue || closeIssue;

  return executeWrite({
    action: "github.write",
    capability: confirmation.action,
    actor: "synchron-x-github",
    sessionId,
    confirmationId,
    resource: resource.repository,
    details: confirmation.action,
    execute: () => {
      switch (confirmation.action) {
        case ACTIONS.CREATE_BRANCH:
          return createBranchAdapter({
            repository: resource.repository,
            branchName: resource.branchName,
            fromBranch: resource.fromBranch,
            accessToken,
          });
        case ACTIONS.CREATE_FILE:
          return createFileAdapter({
            repository: resource.repository,
            branch: resource.branch,
            path: resource.path,
            content: params.content,
            message: params.message,
            accessToken,
          });
        case ACTIONS.UPDATE_FILE:
          return updateFileAdapter({
            repository: resource.repository,
            branch: resource.branch,
            path: resource.path,
            sha: resource.sha,
            content: params.content,
            message: params.message,
            accessToken,
          });
        case ACTIONS.CREATE_PULL_REQUEST:
          return createPrAdapter({
            repository: resource.repository,
            title: params.title,
            body: params.body,
            head: resource.head,
            base: resource.base,
            accessToken,
          });
        case ACTIONS.CLOSE_ISSUE:
          return closeIssueAdapter({
            repository: resource.repository,
            issueNumber: resource.issueNumber,
            accessToken,
          });
        default:
          throw new GitHubServiceError(
            "Неподдържана GitHub промяна.",
            400,
            "UNKNOWN_ACTION",
          );
      }
    },
  });
}

export const GITHUB_CONFIRMED_ACTIONS = ACTIONS;
