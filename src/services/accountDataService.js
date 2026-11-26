import {
  clearProfileMemories,
  deleteAllConversations,
  listAllConversationMessages,
  listProfileMemories,
} from "./memoryService.js";
import {
  deleteWorkspaceState,
  loadWorkspaceState,
} from "./workspaceStateService.js";
import {
  dismissMemorySuggestion,
  listMemorySuggestions,
} from "./memorySuggestionService.js";
import { listActiveMcpGrants, revokeMcpGrants } from "./mcpOAuthService.js";
import { getProductPlansService } from "./productPlansService.js";
import { createAuthClient } from "./userAuthService.js";
import { recordAuditEvent } from "./permissionService.js";
import { getAvatarLinkService } from "./avatarLinkService.js";
import { getPersonalTodoService } from "./personalTodoService.js";

// Self-service GDPR rights for member accounts: a full copy of the data AI
// CORE holds about the account (Art. 15/20) and erasure (Art. 17). Payment
// receipts are not deleted: accounting law requires keeping them.

export const ACCOUNT_DELETE_PHRASE = "ИЗТРИЙ";

export class AccountDataError extends Error {
  constructor(message, status = 400, code = "ACCOUNT_DATA_INVALID") {
    super(message);
    this.name = "AccountDataError";
    this.status = status;
    this.code = code;
  }
}

function assertMember(identity) {
  if (!identity?.id || !identity?.memoryOwnerId) {
    throw new AccountDataError("Нужен е вход в профила.", 401, "AUTH_REQUIRED");
  }
  if (identity.role === "owner") {
    throw new AccountDataError(
      "Профилът на собственика не се изнася или изтрива от тук.",
      403,
      "OWNER_ACCOUNT_PROTECTED",
    );
  }
}

async function optional(read, fallback) {
  try {
    return await read();
  } catch {
    return fallback;
  }
}

export async function exportAccountData(
  identity,
  {
    listMemories = listProfileMemories,
    listMessages = listAllConversationMessages,
    loadWorkspace = loadWorkspaceState,
    listSuggestions = listMemorySuggestions,
    listGrants = listActiveMcpGrants,
    usage = (account) => getProductPlansService().usage(account),
    now = () => new Date(),
  } = {},
) {
  assertMember(identity);
  const ownerId = identity.memoryOwnerId;
  const [memories, messages, workspace, suggestions, grants, plan] =
    await Promise.all([
      listMemories({ ownerId }),
      listMessages(ownerId),
      optional(() => loadWorkspace(ownerId), null),
      optional(() => listSuggestions(ownerId), []),
      optional(() => listGrants({ subject: identity.id }), []),
      optional(() => usage(identity), null),
    ]);
  const conversations = new Map();
  for (const message of messages) {
    if (!message?.sessionId) continue;
    if (!conversations.has(message.sessionId))
      conversations.set(message.sessionId, []);
    conversations.get(message.sessionId).push({
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
      ...(message.source ? { source: message.source } : {}),
    });
  }
  return {
    exportedAt: now().toISOString(),
    service: "AI CORE · СИНХРОН Х ЕООД",
    account: {
      id: identity.id,
      email: identity.email || null,
      authProvider: identity.authProvider || null,
    },
    memories: (Array.isArray(memories) ? memories : [])
      .filter((item) => item?.source !== "system-canonical")
      .map((item) => ({
        id: item.id,
        fact: item.fact,
        scope: item.scope,
        createdAt: item.createdAt || null,
        updatedAt: item.updatedAt || null,
      })),
    memorySuggestions: suggestions,
    conversations: [...conversations.entries()].map(([sessionId, items]) => ({
      sessionId,
      messages: items.sort((a, b) =>
        String(a.createdAt || "").localeCompare(String(b.createdAt || "")),
      ),
    })),
    workspace: workspace?.state || null,
    plan: plan
      ? { plan: plan.plan, remaining: plan.remaining, expiresAt: plan.expiresAt }
      : null,
    connections: (Array.isArray(grants) ? grants : []).map((grant) => ({
      clientId: grant.clientId,
      issuedAt: grant.issuedAt,
      lastUsedAt: grant.lastUsedAt || null,
    })),
  };
}

export async function deleteAccount(
  identity,
  { password, confirm } = {},
  {
    authClient = () => createAuthClient(),
    clearMemories = clearProfileMemories,
    deleteConversations = deleteAllConversations,
    deleteWorkspace = deleteWorkspaceState,
    listSuggestions = listMemorySuggestions,
    dismissSuggestion = dismissMemorySuggestion,
    revokeGrants = revokeMcpGrants,
    audit = recordAuditEvent,
    forgetAvatarLink = (ownerId) => getAvatarLinkService().forget(ownerId),
    clearTodos = (ownerId) => getPersonalTodoService().clear(ownerId),
  } = {},
) {
  assertMember(identity);
  if (confirm !== ACCOUNT_DELETE_PHRASE) {
    throw new AccountDataError(
      `Напиши „${ACCOUNT_DELETE_PHRASE}“, за да потвърдиш.`,
      400,
      "ACCOUNT_DELETE_NOT_CONFIRMED",
    );
  }
  if (typeof password !== "string" || !password || !identity.email) {
    throw new AccountDataError(
      "Въведи паролата си, за да потвърдиш изтриването.",
      400,
      "ACCOUNT_DELETE_PASSWORD_REQUIRED",
    );
  }
  const client = authClient();
  if (typeof client?.auth?.deleteAccount !== "function") {
    throw new AccountDataError(
      "Изтриването на профила временно не е достъпно.",
      503,
      "ACCOUNT_DELETE_UNAVAILABLE",
    );
  }
  const { data, error } = await client.auth.signInWithPassword({
    email: identity.email,
    password,
  });
  if (error || data?.user?.id !== identity.id || !data?.session?.access_token) {
    throw new AccountDataError(
      "Паролата не е вярна.",
      403,
      "ACCOUNT_DELETE_REAUTH_FAILED",
    );
  }

  const ownerId = identity.memoryOwnerId;
  await revokeGrants({ subject: identity.id });
  const suggestions = await listSuggestions(ownerId).catch(() => []);
  for (const item of suggestions) {
    await dismissSuggestion({ ownerId, id: item.id });
  }
  const memories = await clearMemories(undefined, ownerId);
  const conversations = await deleteConversations(ownerId);
  await deleteWorkspace(ownerId);
  // The public "Питай моя аватар" link must stop with the account.
  await forgetAvatarLink(ownerId);
  await clearTodos(ownerId);

  const removed = await client.auth.deleteAccount(data.session.access_token);
  if (removed?.error) {
    throw new AccountDataError(
      "Данните са изтрити, но профилът за вход не беше премахнат. Опитай отново.",
      503,
      "ACCOUNT_DELETE_INCOMPLETE",
    );
  }
  try {
    await audit({
      actor: identity.id,
      action: "account.delete",
      capability: "account.manage",
      decision: "confirmed",
      outcome: "succeeded",
      resource: "account",
      details: "self_service",
      sessionId: identity.id,
    });
  } catch {
    // The account is already gone; a missing audit entry must not undo it.
  }
  return { deleted: true, memories, conversations };
}
