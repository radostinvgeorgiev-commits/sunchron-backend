import { createHash } from "node:crypto";

import { isCopilotAutomationEnabled } from "../config/featureFlags.js";
import {
  createDurableConfirmation,
  markDurableConfirmationUsed,
  validateDurableConfirmation,
} from "./confirmationService.js";
import {
  getGitHubSession,
  GitHubOAuthError,
  isAuthorizedGitHubLogin,
  isGitHubOAuthConfigured,
} from "./githubOAuthService.js";
import {
  executeAuditedWriteAction,
  isAuditSafetyError,
} from "./permissionService.js";

const DEFAULT_REPOSITORY = "radostinvgeorgiev-commits/sunchron-backend";
const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";
const GITHUB_FEATURES =
  "issues_copilot_assignment_api_support,coding_agent_model_selection";
const DEFAULT_TIMEOUT_MS = 15000;
const CONFIRM_PREFIX = "Потвърждавам GitHub задача:";
const COPILOT_LOGIN = "copilot-swe-agent";

export class CopilotTaskError extends Error {
  constructor(message, status = 502, code = "COPILOT_TASK_ERROR") {
    super(message);
    this.name = "CopilotTaskError";
    this.status = status;
    this.code = code;
  }
}

function configuredRepository() {
  return (process.env.GITHUB_REPOSITORY || DEFAULT_REPOSITORY).trim();
}

function splitRepository(repository = configuredRepository()) {
  if (repository !== configuredRepository()) {
    throw new CopilotTaskError(
      "Това GitHub хранилище не е разрешено.",
      403,
      "REPOSITORY_NOT_ALLOWED",
    );
  }
  const [owner, name, ...rest] = repository.split("/");
  if (!owner || !name || rest.length) {
    throw new CopilotTaskError(
      "GitHub хранилището е невалидно.",
      500,
      "INVALID_REPOSITORY",
    );
  }
  return { owner, name, repository };
}

function taskTitle(prompt) {
  const clean = String(prompt || "")
    .replace(/\s+/gu, " ")
    .trim();
  if (!clean) return "SYNCHRON-X кодова задача";
  const firstSentence = clean.split(/(?<=[.!?])\s/u)[0];
  return firstSentence.slice(0, 80);
}

function assertBaseRef(baseRef) {
  if (baseRef !== "main") {
    throw new CopilotTaskError(
      "Copilot задачите могат да започват само от защитения main клон.",
      403,
      "BASE_REF_NOT_ALLOWED",
    );
  }
}

function taskFingerprint(prompt, repository, baseRef) {
  return createHash("sha256")
    .update(
      `${repository}\u0000${baseRef}\u0000${prompt.replace(/\s+/gu, " ").trim()}`,
    )
    .digest("hex")
    .slice(0, 24);
}

function taskMarker(fingerprint) {
  return `<!-- synchron-copilot-task:${fingerprint} -->`;
}

function hasConfirmedCopilotAssignee(issue) {
  return Boolean(
    issue?.assignees?.nodes?.some((actor) => actor?.login === COPILOT_LOGIN),
  );
}

export function extractCopilotTaskNumber(message) {
  const text = typeof message === "string" ? message.trim() : "";
  if (!text) return null;
  const mentionsStatus =
    /(?:статус|състояние|какво\s+става|докъде|прослед|провери|готов|работи|ci|checks?|проверки|deployment|деплой|публикуван)/iu.test(
      text,
    );
  const mentionsTask =
    /(?:copilot|копилот|github|ги[тд][\s-]*хъб|задач|issue|pull\s*request|\bpr\b)/iu.test(
      text,
    );
  if (!mentionsStatus || !mentionsTask) return null;
  const match = text.match(
    /#\s*(\d{1,10})|(?:задач|issue|\bpr\b)[^\d]{0,20}(\d{1,10})/iu,
  );
  const value = Number(match?.[1] || match?.[2]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function isCopilotTaskStatusRequest(message) {
  return extractCopilotTaskNumber(message) !== null;
}

export function isCopilotBridgeStatusRequest(message) {
  const text =
    typeof message === "string"
      ? message.trim().toLocaleLowerCase("bg-BG")
      : "";
  if (!text) return false;

  const mentionsGitHub =
    /(?:\bgithub\b|ги[тд][\s-]*хъб|(?:^|\s)хъб(?:ът|а)?(?=\s|[?!.,:;]|$)|github\s*write)/iu.test(
      text,
    );
  const mentionsWrite =
    /(?:пиш(?:е|а|еш)|писан|запис|\bwrite\b|branch|клон|commit|комит|pull\s*request|\bpr\b|copilot|копилот|merge|слив)/iu.test(
      text,
    );
  const asksAvailability =
    /(?:може\s+ли|може\s+вече|може\s+да|работи\s+ли|има\s+ли|активен|наличен|свързан|готов|инструмент|мост)/iu.test(
      text,
    );
  const givesImplementationOrder =
    /(?:^|\s)(?:направи|промени|обнови|редактирай|поправи|създай|слей)(?:\s|$)/iu.test(
      text,
    );

  return (
    mentionsGitHub &&
    mentionsWrite &&
    asksAvailability &&
    !givesImplementationOrder
  );
}

async function githubGraphql(accessToken, query, variables, fetchImpl = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetchImpl(GITHUB_GRAPHQL_URL, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "GraphQL-Features": GITHUB_FEATURES,
        "User-Agent": "Synchron-X",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
    const data = await response.json();
    if (!response.ok || data.errors?.length) {
      const reasonCode =
        data.errors
          ?.map((error) => error?.type)
          .filter(Boolean)
          .join(",") || "GRAPHQL_ERROR";
      console.error(
        "[Copilot task] GitHub GraphQL failure:",
        response.status,
        reasonCode,
      );
      throw new CopilotTaskError(
        "GitHub Copilot не прие задачата.",
        response.status || 502,
        "COPILOT_API_REJECTED",
      );
    }
    return data.data;
  } catch (error) {
    if (error instanceof CopilotTaskError) throw error;
    if (error?.name === "AbortError") {
      throw new CopilotTaskError(
        "GitHub Copilot не отговори навреме.",
        504,
        "COPILOT_TIMEOUT",
      );
    }
    throw new CopilotTaskError(
      "Връзката с GitHub Copilot не е достъпна.",
      503,
      "COPILOT_UNAVAILABLE",
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveCopilotContext(accessToken, repository, fetchImpl) {
  const { owner, name } = splitRepository(repository);
  const data = await githubGraphql(
    accessToken,
    `
      query CopilotContext($owner: String!, $name: String!) {
        repository(owner: $owner, name: $name) {
          id
          suggestedActors(capabilities: [CAN_BE_ASSIGNED], first: 100) {
            nodes {
              __typename
              ... on Bot { id login }
              ... on User { id login }
            }
          }
        }
      }
    `,
    { owner, name },
    fetchImpl,
  );
  const repositoryData = data?.repository;
  if (!repositoryData?.id) {
    throw new CopilotTaskError(
      "Разрешеното GitHub хранилище не е намерено.",
      404,
      "REPOSITORY_NOT_FOUND",
    );
  }
  const copilot = repositoryData.suggestedActors?.nodes?.find(
    (actor) => actor?.login === "copilot-swe-agent",
  );
  if (!copilot?.id) {
    throw new CopilotTaskError(
      "GitHub Copilot cloud agent не е включен за това хранилище.",
      403,
      "COPILOT_NOT_ENABLED",
    );
  }
  return { repositoryId: repositoryData.id, copilotId: copilot.id };
}

async function findExistingCopilotTask(
  accessToken,
  repository,
  fingerprint,
  fetchImpl,
) {
  const { owner, name } = splitRepository(repository);
  const data = await githubGraphql(
    accessToken,
    `
      query ExistingCopilotTasks($owner: String!, $name: String!) {
        repository(owner: $owner, name: $name) {
          issues(
            first: 100
            states: [OPEN]
            orderBy: { field: UPDATED_AT, direction: DESC }
          ) {
            nodes {
              number
              title
              url
              body
              assignees(first: 10) { nodes { login } }
            }
          }
        }
      }
    `,
    { owner, name },
    fetchImpl,
  );
  const marker = taskMarker(fingerprint);
  return (
    data?.repository?.issues?.nodes?.find((issue) =>
      String(issue?.body || "").includes(marker),
    ) || null
  );
}

function normalizeCheckContext(context) {
  if (context?.__typename === "CheckRun") {
    return {
      name: context.name || "GitHub check",
      state: context.conclusion || context.status || "UNKNOWN",
      url: context.detailsUrl || null,
    };
  }
  return {
    name: context?.context || "GitHub status",
    state: context?.state || "UNKNOWN",
    url: context?.targetUrl || null,
  };
}

function taskStatusRollup(pullRequest) {
  if (pullRequest?.merged) {
    return pullRequest.mergeCommit?.statusCheckRollup || null;
  }
  return pullRequest?.statusCheckRollup || null;
}

function classifyCopilotTask(issue, pullRequest) {
  if (!pullRequest) {
    if (issue?.state === "CLOSED") return "needs-attention";
    return hasConfirmedCopilotAssignee(issue) ? "copilot-working" : "waiting";
  }
  if (
    pullRequest.baseRefName !== "main" ||
    pullRequest.headRefName === "main"
  ) {
    return "unsafe-branch";
  }
  const rollup = taskStatusRollup(pullRequest);
  const checks = (rollup?.contexts?.nodes || []).map(normalizeCheckContext);
  const production = checks.find(
    (check) => check.name === "synchron/production-smoke",
  );
  if (pullRequest.merged) {
    if (production?.state === "SUCCESS") return "real-tested";
    if (["ERROR", "FAILURE"].includes(production?.state)) {
      return "deployment-failed";
    }
    return "merged";
  }
  if (pullRequest.state === "CLOSED") return "needs-attention";
  if (pullRequest.isDraft) return "draft-pr";
  const rollupState = rollup?.state || "EXPECTED";
  if (["ERROR", "FAILURE"].includes(rollupState)) return "checks-needed";
  if (["PENDING", "EXPECTED"].includes(rollupState)) return "checks-running";
  if (rollupState === "SUCCESS") return "ready-for-review";
  return "checks-running";
}

export async function getCopilotTaskStatus({
  githubSessionId,
  githubSession,
  issueNumber,
  repository = configuredRepository(),
  fetchImpl = fetch,
}) {
  const session = githubSession || (await getGitHubSession(githubSessionId));
  if (!session || !isAuthorizedGitHubLogin(session.login)) {
    throw new GitHubOAuthError(
      "Първо свържи разрешения GitHub профил от „Инструменти“.",
      401,
      "GITHUB_SESSION_REQUIRED",
    );
  }
  const cleanIssueNumber = Number(issueNumber);
  if (!Number.isSafeInteger(cleanIssueNumber) || cleanIssueNumber <= 0) {
    throw new CopilotTaskError(
      "Невалиден номер на GitHub задача.",
      400,
      "INVALID_ISSUE_NUMBER",
    );
  }
  const { owner, name } = splitRepository(repository);
  const data = await githubGraphql(
    session.accessToken,
    `
      query CopilotTaskStatus(
        $owner: String!
        $name: String!
        $issueNumber: Int!
      ) {
        repository(owner: $owner, name: $name) {
          issueOrPullRequest(number: $issueNumber) {
            __typename
            ... on Issue {
              number
              title
              url
              state
              assignees(first: 10) { nodes { login } }
              closedByPullRequestsReferences(first: 20) {
                nodes {
                  ...CopilotPullRequestStatus
                }
              }
              timelineItems(first: 100, itemTypes: [CROSS_REFERENCED_EVENT]) {
                nodes {
                  ... on CrossReferencedEvent {
                    source {
                      ... on PullRequest {
                        ...CopilotPullRequestStatus
                      }
                    }
                  }
                }
              }
            }
            ... on PullRequest {
              ...CopilotPullRequestStatus
            }
          }
        }
      }

      fragment CopilotPullRequestStatus on PullRequest {
        number
        title
        url
        state
        isDraft
        merged
        mergedAt
        baseRefName
        headRefName
        headRefOid
        statusCheckRollup {
          state
          contexts(first: 100) {
            nodes {
              __typename
              ... on CheckRun {
                name
                status
                conclusion
                detailsUrl
              }
              ... on StatusContext {
                context
                state
                targetUrl
              }
            }
          }
        }
        mergeCommit {
          oid
          statusCheckRollup {
            state
            contexts(first: 100) {
              nodes {
                __typename
                ... on CheckRun {
                  name
                  status
                  conclusion
                  detailsUrl
                }
                ... on StatusContext {
                  context
                  state
                  targetUrl
                }
              }
            }
          }
        }
      }
    `,
    { owner, name, issueNumber: cleanIssueNumber },
    fetchImpl,
  );
  const trackedResource = data?.repository?.issueOrPullRequest || null;
  const issue = trackedResource?.__typename === "Issue" ? trackedResource : null;
  const directPullRequest =
    trackedResource?.__typename === "PullRequest" ? trackedResource : null;
  if (
    (!issue?.number || !issue?.url) &&
    (!directPullRequest?.number || !directPullRequest?.url)
  ) {
    throw new CopilotTaskError(
      "GitHub задачата или Pull Request-ът не е намерен в разрешеното хранилище.",
      404,
      "COPILOT_TASK_NOT_FOUND",
    );
  }
  const trackedItem =
    issue ||
    Object.freeze({
      number: directPullRequest.number,
      title: directPullRequest.title,
      url: directPullRequest.url,
      state: directPullRequest.state === "OPEN" ? "OPEN" : "CLOSED",
      assignees: { nodes: [] },
    });
  const pullRequests = [
    ...(directPullRequest ? [directPullRequest] : []),
    ...(issue?.closedByPullRequestsReferences?.nodes || []),
    ...(issue?.timelineItems?.nodes || [])
      .map((event) => event?.source)
      .filter(Boolean),
  ].filter(
    (candidate, index, items) =>
      candidate?.number &&
      items.findIndex((item) => item?.number === candidate.number) === index,
  );
  const pullRequest =
    pullRequests.find((candidate) => candidate?.state === "OPEN") ||
    pullRequests.find((candidate) => candidate?.merged) ||
    pullRequests[0] ||
    null;
  const checks = (taskStatusRollup(pullRequest)?.contexts?.nodes || []).map(
    normalizeCheckContext,
  );
  return Object.freeze({
    repository,
    resourceType: issue ? "issue" : "pull-request",
    issue: {
      number: trackedItem.number,
      title: trackedItem.title,
      url: trackedItem.url,
      state: trackedItem.state,
      copilotAssigned: hasConfirmedCopilotAssignee(trackedItem),
    },
    pullRequest: pullRequest
      ? {
          number: pullRequest.number,
          title: pullRequest.title,
          url: pullRequest.url,
          state: pullRequest.state,
          draft: Boolean(pullRequest.isDraft),
          merged: Boolean(pullRequest.merged),
          mergedAt: pullRequest.mergedAt || null,
          baseRef: pullRequest.baseRefName,
          headRef: pullRequest.headRefName,
          headSha: pullRequest.headRefOid,
          mergeSha: pullRequest.mergeCommit?.oid || null,
        }
      : null,
    checks,
    status: classifyCopilotTask(trackedItem, pullRequest),
  });
}

export function formatCopilotTaskStatus(result) {
  const labels = {
    waiting: "чака назначаване на Copilot",
    "copilot-working": "Copilot работи; Pull Request още няма",
    "draft-pr": "има Draft Pull Request",
    "checks-running": "проверките работят",
    "checks-needed": "има неуспешни проверки и са нужни поправки",
    "ready-for-review": "проверките са зелени и PR е готов за преглед",
    merged: "PR е слят; production проверката още не е завършила",
    "deployment-failed": "PR е слят, но production проверката е неуспешна",
    "real-tested": "публикувано и реално проверено в production",
    "needs-attention": "PR е затворен без сливане",
    "unsafe-branch": "PR нарушава защитения клонов процес",
  };
  const failedChecks = result.checks.filter((check) =>
    ["ERROR", "FAILURE", "CANCELLED", "TIMED_OUT"].includes(check.state),
  );
  const isDirectPullRequest = result.resourceType === "pull-request";
  return [
    `${isDirectPullRequest ? "GitHub Pull Request" : "GitHub задача"} #${result.issue.number}: ${result.issue.title}`,
    `Състояние: ${labels[result.status] || result.status}.`,
    `${isDirectPullRequest ? "Pull Request" : "Задача"}: ${result.issue.url}`,
    ...(result.pullRequest && !isDirectPullRequest
      ? [
          `Pull Request: #${result.pullRequest.number} — ${result.pullRequest.url}`,
        ]
      : []),
    ...(result.pullRequest
      ? [`Клон: ${result.pullRequest.headRef} → ${result.pullRequest.baseRef}`]
      : []),
    ...(failedChecks.length
      ? [
          `Неуспешни проверки: ${failedChecks.map((check) => check.name).join(", ")}.`,
        ]
      : []),
  ].join("\n");
}

export async function getCopilotBridgeStatus({
  githubSessionId,
  repository = configuredRepository(),
  fetchImpl = fetch,
} = {}) {
  splitRepository(repository);
  if (!isCopilotAutomationEnabled()) {
    return Object.freeze({
      status: "disabled",
      configured: isGitHubOAuthConfigured(),
      connected: false,
      copilotEnabled: false,
      repository,
      mode: "disabled-without-copilot",
      reasonCode: "COPILOT_AUTOMATION_DISABLED",
    });
  }
  if (!isGitHubOAuthConfigured()) {
    return Object.freeze({
      status: "not-configured",
      configured: false,
      connected: false,
      copilotEnabled: false,
      repository,
      mode: "confirmed-copilot-task",
    });
  }

  const session = await getGitHubSession(githubSessionId);
  if (!session || !isAuthorizedGitHubLogin(session.login)) {
    return Object.freeze({
      status: "not-connected",
      configured: true,
      connected: false,
      copilotEnabled: false,
      repository,
      mode: "confirmed-copilot-task",
    });
  }

  try {
    await resolveCopilotContext(session.accessToken, repository, fetchImpl);
    return Object.freeze({
      status: "ready",
      configured: true,
      connected: true,
      copilotEnabled: true,
      repository,
      mode: "confirmed-copilot-task",
      createsBranch: true,
      createsCommits: true,
      createsPullRequest: true,
      mergesMainAutomatically: false,
    });
  } catch (error) {
    if (!(error instanceof CopilotTaskError)) throw error;
    return Object.freeze({
      status: "unavailable",
      configured: true,
      connected: true,
      copilotEnabled: false,
      repository,
      mode: "confirmed-copilot-task",
      reasonCode: error.code,
    });
  }
}

export function formatCopilotBridgeStatus(status) {
  if (status.reasonCode === "COPILOT_AUTOMATION_DISABLED") {
    return [
      "Проверих текущия режим за GitHub Write.",
      "Резултат: изключен е — работим без Copilot.",
      "GitHub Read остава активен; кодовият мост не прави assignment, branch, commit или Pull Request.",
    ].join("\n");
  }
  if (!status.configured) {
    return [
      "Проверих GitHub Write моста реално.",
      "Резултат: не е конфигуриран.",
      "Липсва пълна сървърна GitHub OAuth конфигурация.",
    ].join("\n");
  }
  if (!status.connected) {
    return [
      "Проверих GitHub Write моста реално.",
      "Резултат: конфигуриран е, но текущата сесия не е свързана с разрешения GitHub профил.",
      "Свържи GitHub от „Връзки“ и повтори проверката.",
    ].join("\n");
  }
  if (!status.copilotEnabled) {
    return [
      "Проверих GitHub Write моста реално.",
      "GitHub входът е свързан, но Copilot cloud agent не е достъпен за разрешеното хранилище.",
      `Код на проверката: ${status.reasonCode || "COPILOT_UNAVAILABLE"}.`,
    ].join("\n");
  }
  return [
    "Проверих GitHub Write моста реално: работи.",
    `Хранилище: ${status.repository}.`,
    "След конкретна кодова задача SYNCHRON-X подготвя еднократно потвърждение.",
    "След потвърждението GitHub Copilot работи в отделен клон, прави commit-и и създава Pull Request.",
    "Не слива автоматично в main и не публикува без отделно изрично потвърждение.",
  ].join("\n");
}

export async function startCopilotTask({
  githubSessionId,
  prompt,
  repository = configuredRepository(),
  baseRef = "main",
  fetchImpl = fetch,
}) {
  if (!isCopilotAutomationEnabled()) {
    throw new CopilotTaskError(
      "GitHub Write е изключен — режим без Copilot.",
      503,
      "COPILOT_AUTOMATION_DISABLED",
    );
  }
  const session = await getGitHubSession(githubSessionId);
  if (!session || !isAuthorizedGitHubLogin(session.login)) {
    throw new GitHubOAuthError(
      "Първо свържи GitHub от „Инструменти“.",
      401,
      "GITHUB_SESSION_REQUIRED",
    );
  }
  const cleanPrompt = typeof prompt === "string" ? prompt.trim() : "";
  if (!cleanPrompt) {
    throw new CopilotTaskError(
      "Липсва кодова задача за Copilot.",
      400,
      "MISSING_COPILOT_PROMPT",
    );
  }
  splitRepository(repository);
  assertBaseRef(baseRef);
  const fingerprint = taskFingerprint(cleanPrompt, repository, baseRef);
  const { repositoryId, copilotId } = await resolveCopilotContext(
    session.accessToken,
    repository,
    fetchImpl,
  );
  const existingIssue = await findExistingCopilotTask(
    session.accessToken,
    repository,
    fingerprint,
    fetchImpl,
  );
  if (existingIssue) {
    if (!hasConfirmedCopilotAssignee(existingIssue)) {
      throw new CopilotTaskError(
        "Съществуващата GitHub задача не е потвърдено назначена на Copilot.",
        409,
        "COPILOT_ASSIGNMENT_UNCONFIRMED",
      );
    }
    return {
      issueNumber: existingIssue.number,
      title: existingIssue.title,
      url: existingIssue.url,
      repository,
      assignee: COPILOT_LOGIN,
      deduplicated: true,
    };
  }
  const data = await githubGraphql(
    session.accessToken,
    `
      mutation StartCopilotTask(
        $repositoryId: ID!
        $copilotId: ID!
        $title: String!
        $body: String!
        $baseRef: String!
        $instructions: String!
      ) {
        createIssue(input: {
          repositoryId: $repositoryId
          title: $title
          body: $body
          assigneeIds: [$copilotId]
          agentAssignment: {
            targetRepositoryId: $repositoryId
            baseRef: $baseRef
            customInstructions: $instructions
          }
        }) {
          issue {
            number
            title
            url
            assignees(first: 10) { nodes { login } }
          }
        }
      }
    `,
    {
      repositoryId,
      copilotId,
      title: taskTitle(cleanPrompt),
      body: [
        "Задача, потвърдена от потребителя в SYNCHRON-X:",
        "",
        cleanPrompt,
        "",
        taskMarker(fingerprint),
      ].join("\n"),
      baseRef,
      instructions: [
        "Работи само по описаната задача.",
        "Създай отделен клон и Pull Request.",
        "Не сливай Pull Request и не публикувай deployment.",
        "Пусни наличните тестове и опиши резултата.",
      ].join(" "),
    },
    fetchImpl,
  );
  const issue = data?.createIssue?.issue;
  if (!issue?.number || !issue?.url) {
    throw new CopilotTaskError(
      "GitHub Copilot не върна валидна задача.",
      502,
      "COPILOT_EMPTY_RESULT",
    );
  }
  if (!hasConfirmedCopilotAssignee(issue)) {
    throw new CopilotTaskError(
      "GitHub създаде задачата, но не потвърди назначаването на Copilot.",
      502,
      "COPILOT_ASSIGNMENT_UNCONFIRMED",
    );
  }
  return {
    issueNumber: issue.number,
    title: issue.title,
    url: issue.url,
    repository,
    assignee: COPILOT_LOGIN,
    deduplicated: false,
  };
}

export async function prepareCopilotTask({
  sessionId,
  githubSessionId,
  prompt,
  repository = configuredRepository(),
  baseRef = "main",
}) {
  const githubSession = await getGitHubSession(githubSessionId);
  if (!githubSession || !isAuthorizedGitHubLogin(githubSession.login)) {
    throw new GitHubOAuthError(
      "Първо свържи GitHub от „Инструменти“.",
      401,
      "GITHUB_SESSION_REQUIRED",
    );
  }
  splitRepository(repository);
  assertBaseRef(baseRef);
  const cleanPrompt = typeof prompt === "string" ? prompt.trim() : "";
  if (!cleanPrompt) {
    throw new CopilotTaskError(
      "Липсва кодова задача за Copilot.",
      400,
      "MISSING_COPILOT_PROMPT",
    );
  }
  const confirmation = await createDurableConfirmation({
    sessionId,
    action: "github.copilot:start_task",
    resource: { repository, baseRef },
    params: { prompt: cleanPrompt },
  });
  return {
    confirmationId: confirmation.id,
    expiresAt: confirmation.expiresAt,
    output: [
      "Подготвих кодовата задача за GitHub Copilot.",
      `Хранилище: ${repository}`,
      `Начален клон: ${baseRef}`,
      `Задача: ${cleanPrompt}`,
      "Copilot ще работи в отделен клон и ще създаде Pull Request. Няма да слива в main.",
      "За изпълнение изпрати точно:",
      `${CONFIRM_PREFIX} ${confirmation.id}`,
    ].join("\n"),
  };
}

export function extractCopilotConfirmationId(message) {
  if (typeof message !== "string") return null;
  const match = message
    .trim()
    .match(/^Потвърждавам GitHub задача:\s*([0-9a-f]{8}-[0-9a-f-]{27,})$/iu);
  return match?.[1] || null;
}

export async function confirmCopilotTask({
  confirmationId,
  sessionId,
  githubSessionId,
  fetchImpl = fetch,
  executeWrite = executeAuditedWriteAction,
}) {
  const confirmation = await validateDurableConfirmation(
    confirmationId,
    sessionId,
  );
  if (confirmation.action !== "github.copilot:start_task") {
    throw new CopilotTaskError(
      "Потвърждението не е за GitHub Copilot задача.",
      400,
      "CONFIRMATION_ACTION_MISMATCH",
    );
  }
  await markDurableConfirmationUsed(confirmationId);
  try {
    return await executeWrite({
      action: "github.write",
      capability: "code.write",
      sessionId,
      confirmationId,
      resource: confirmation.resource.repository,
      details: "github.copilot:start_task",
      execute: () =>
        startCopilotTask({
          githubSessionId,
          prompt: confirmation.params.prompt,
          repository: confirmation.resource.repository,
          baseRef: confirmation.resource.baseRef,
          fetchImpl,
        }),
    });
  } catch (error) {
    if (isAuditSafetyError(error)) {
      throw new CopilotTaskError(error.message, error.status, error.code);
    }
    throw error;
  }
}

export function formatCopilotTaskResult(result) {
  return [
    result.deduplicated
      ? "Същата GitHub задача вече съществува; не създадох дубликат."
      : "GitHub Copilot прие задачата.",
    `Задача: #${result.issueNumber} — ${result.title}`,
    `Проследяване: ${result.url}`,
    "Copilot работи в GitHub. Когато създаде Pull Request, той трябва да бъде прегледан преди сливане.",
  ].join("\n");
}
