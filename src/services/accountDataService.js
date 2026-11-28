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
import { getBookMemoryService } from "./bookMemoryService.js";
import { getAddonService } from "./addonService.js";
import { getClaudeWorkService } from "./claudeWorkService.js";
import { getAvatarProfileService } from "./avatarProfileService.js";

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
    listProjects = (ownerId) => getBookMemoryService().exportAll(ownerId),
    now = () => new Date(),
  } = {},
) {
  assertMember(identity);
  const ownerId = identity.memoryOwnerId;
  const [memories, messages, workspace, suggestions, grants, plan, projects] =
    await Promise.all([
      listMemories({ ownerId }),
      listMessages(ownerId),
      optional(() => loadWorkspace(ownerId), null),
      optional(() => listSuggestions(ownerId), []),
      optional(() => listGrants({ subject: identity.id }), []),
      optional(() => usage(identity), null),
      // The project memory of every specialist (books, cases, the health
      // diary…), with the full text of each part. A failed read fails the
      // copy, as for memories and messages, so it is never silently empty.
      listProjects(ownerId),
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
    service: "NovariumAI · СИНХРОН Х ЕООД",
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
    projects: Array.isArray(projects) ? projects : [],
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

// People who sign in with Google, GitHub or another external profile have no
// password. They confirm with a sign-in from the last few minutes instead, the
// same rule Identity Platform applies before it deletes a sign-in account.
export const RECENT_SIGN_IN_SECONDS = 5 * 60;

async function confirmWithPassword(client, identity, password) {
  if (!identity.email) {
    throw new AccountDataError(
      "Въведи паролата си, за да потвърдиш изтриването.",
      400,
      "ACCOUNT_DELETE_PASSWORD_REQUIRED",
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
  return data.session.access_token;
}

function tokenSignInTime(token) {
  try {
    const payload = JSON.parse(
      Buffer.from(String(token).split(".")[1] || "", "base64url").toString("utf8"),
    );
    return Number(payload.auth_time) || 0;
  } catch {
    return 0;
  }
}

async function confirmWithRecentSignIn(client, identity, session, nowMs) {
  let token = session.access_token;
  let user = null;
  if (token && typeof client.auth.getUser === "function") {
    const result = await client.auth.getUser(token);
    if (!result?.error) user = result?.data?.user || null;
  }
  if (!user && session.refresh_token && typeof client.auth.refreshSession === "function") {
    const result = await client.auth.refreshSession({ refresh_token: session.refresh_token });
    if (!result?.error && result?.data?.session?.access_token) {
      token = result.data.session.access_token;
      user = result.data.user || null;
    }
  }
  if (!user || user.id !== identity.id || !token) {
    throw new AccountDataError(
      "Влез отново и опитай пак.",
      403,
      "ACCOUNT_DELETE_REAUTH_FAILED",
    );
  }
  const signedInAt = tokenSignInTime(token);
  if (!signedInAt || nowMs / 1000 - signedInAt > RECENT_SIGN_IN_SECONDS) {
    throw new AccountDataError(
      "За да изтриеш профила, излез, влез отново и го изтрий до 5 минути.",
      403,
      "ACCOUNT_DELETE_SIGN_IN_AGAIN",
    );
  }
  return token;
}

export async function deleteAccount(
  identity,
  { password, confirm, session } = {},
  {
    authClient = () => createAuthClient(),
    now = () => Date.now(),
    clearMemories = clearProfileMemories,
    deleteConversations = deleteAllConversations,
    deleteWorkspace = deleteWorkspaceState,
    listSuggestions = listMemorySuggestions,
    dismissSuggestion = dismissMemorySuggestion,
    revokeGrants = revokeMcpGrants,
    audit = recordAuditEvent,
    forgetAvatarLink = (ownerId) => getAvatarLinkService().forget(ownerId),
    clearTodos = (ownerId) => getPersonalTodoService().clear(ownerId),
    clearBooks = (ownerId) => getBookMemoryService().clear(ownerId),
    clearAddons = (ownerId) => getAddonService().clear(ownerId),
    clearClaudeWork = (ownerId) => getClaudeWorkService().clear(ownerId),
    forgetAvatarProfile = (ownerId) => getAvatarProfileService().forget(ownerId),
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
  const hasPassword = typeof password === "string" && password.length > 0;
  if (!hasPassword && !session?.refresh_token && !session?.access_token) {
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
  const accessToken = hasPassword
    ? await confirmWithPassword(client, identity, password)
    : await confirmWithRecentSignIn(client, identity, session, now());

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
  await clearBooks(ownerId);
  await clearAddons(ownerId);
  await clearClaudeWork(ownerId);
  await forgetAvatarProfile(ownerId);

  const removed = await client.auth.deleteAccount(accessToken);
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
