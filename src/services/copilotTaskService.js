import {
  createConfirmation,
  markConfirmationUsed,
  validateConfirmation,
} from "./confirmationService.js";
import { getGitHubSession, GitHubOAuthError } from "./githubOAuthService.js";

const DEFAULT_REPOSITORY = "radostinvgeorgiev-commits/sunchron-backend";
const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";
const GITHUB_FEATURES =
  "issues_copilot_assignment_api_support,coding_agent_model_selection";
const DEFAULT_TIMEOUT_MS = 15000;
const CONFIRM_PREFIX = "Потвърждавам GitHub задача:";

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
      const reason = data.errors?.[0]?.message || `HTTP ${response.status}`;
      console.error("[Copilot task] GitHub GraphQL failure:", reason);
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

export async function startCopilotTask({
  githubSessionId,
  prompt,
  repository = configuredRepository(),
  baseRef = "main",
  fetchImpl = fetch,
}) {
  const session = await getGitHubSession(githubSessionId);
  if (!session) {
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
  const { repositoryId, copilotId } = await resolveCopilotContext(
    session.accessToken,
    repository,
    fetchImpl,
  );
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
  return {
    issueNumber: issue.number,
    title: issue.title,
    url: issue.url,
    repository,
    assignee: issue.assignees?.nodes?.[0]?.login || "copilot-swe-agent",
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
  if (!githubSession) {
    throw new GitHubOAuthError(
      "Първо свържи GitHub от „Инструменти“.",
      401,
      "GITHUB_SESSION_REQUIRED",
    );
  }
  const confirmation = createConfirmation({
    sessionId,
    action: "github.copilot:start_task",
    resource: { repository, baseRef },
    params: { prompt },
  });
  return {
    confirmationId: confirmation.id,
    expiresAt: confirmation.expiresAt,
    output: [
      "Подготвих кодовата задача за GitHub Copilot.",
      `Хранилище: ${repository}`,
      `Начален клон: ${baseRef}`,
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
}) {
  const confirmation = validateConfirmation(confirmationId, sessionId);
  if (confirmation.action !== "github.copilot:start_task") {
    throw new CopilotTaskError(
      "Потвърждението не е за GitHub Copilot задача.",
      400,
      "CONFIRMATION_ACTION_MISMATCH",
    );
  }
  markConfirmationUsed(confirmationId);
  return startCopilotTask({
    githubSessionId,
    prompt: confirmation.params.prompt,
    repository: confirmation.resource.repository,
    baseRef: confirmation.resource.baseRef,
    fetchImpl,
  });
}

export function formatCopilotTaskResult(result) {
  return [
    "GitHub Copilot прие задачата.",
    `Задача: #${result.issueNumber} — ${result.title}`,
    `Проследяване: ${result.url}`,
    "Copilot работи в GitHub. Когато създаде Pull Request, той трябва да бъде прегледан преди сливане.",
  ].join("\n");
}
