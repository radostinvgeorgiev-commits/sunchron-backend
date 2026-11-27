import { AsyncLocalStorage } from "node:async_hooks";
import { PROJECT_REFERENCE_HEADER } from "./projectConversationContextService.js";
import {
  getProductPlansService,
  ProductError,
  PUBLIC_REQUEST_CREDITS,
} from "./productPlansService.js";
const context = new AsyncLocalStorage();
export function createPublicAiBudgetContext({
  reserve = (identity, credits, details) =>
    getProductPlansService().reserve(identity, credits, details),
  refund = (identity, reservationId) =>
    getProductPlansService().refund(identity, reservationId),
} = {}) {
  return (req, _res, next) => {
    if (req.owner?.role === "owner") return next();
    return context.run({ identity: req.owner, calls: 0, reserve, refund }, next);
  };
}
export const publicAiBudgetContext = createPublicAiBudgetContext();
// A plain conversation turn with an economical model: its text calls cost no
// units. Pictures, files, voice and drawings in the same turn still do.
export function markFreeChatTurn() {
  const scope = context.getStore();
  if (scope) scope.free = true;
}
export function isFreeChatTurn() {
  return context.getStore()?.free === true;
}
export function publicAiOutputLimit() {
  return context.getStore() ? 1024 : null;
}
// A picture or PDF costs more than a text turn: one call, fixed price.
export const PUBLIC_FILE_CREDITS = 2;
export async function reservePublicAiFile(provider = "", model = "") {
  const scope = context.getStore();
  if (!scope) return;
  if (scope.calls >= 6)
    throw new ProductError(
      "Достигнат е лимитът за опити в тази задача.",
      "AI_ATTEMPT_LIMIT",
      429,
    );
  scope.calls++;
  await scope.reserve(scope.identity, PUBLIC_FILE_CREDITS, { provider, model });
}
// A meeting recording is priced by size: 2 units per started 10 MB
// (about 10 minutes of a phone voice memo), whatever the number of calls.
export function meetingCredits(bytes = 0) {
  return PUBLIC_FILE_CREDITS * Math.max(1, Math.ceil(Number(bytes || 0) / (10 * 1024 * 1024)));
}
export async function reservePublicAiMeeting(bytes, provider = "", model = "") {
  const scope = context.getStore();
  if (!scope) return;
  await scope.reserve(scope.identity, meetingCredits(bytes), { provider, model });
}
export const PUBLIC_CONTEXT_LIMIT = 32000;
// A member's long conversation used to stop with "Контекстът е твърде дълъг"
// after about ten exchanges. Instead the oldest turns are left out, as a person
// forgets the start of a long talk; the instructions and the newest message
// always stay. The linked-chats reference, which comes before the history,
// goes only when no older turn is left to drop. Only applies inside a
// member's request (the owner has no cap).
export function fitPublicAiInput(input, limit = PUBLIC_CONTEXT_LIMIT) {
  if (!context.getStore() || !Array.isArray(input)) return input;
  const size = (items) => JSON.stringify(items).length;
  if (size(input) <= limit) return input;
  const kept = [...input];
  // Drops the oldest items `canDrop` allows until the input fits; the newest
  // item is never dropped.
  const dropOldest = (canDrop) => {
    for (let index = 0; index < kept.length - 1 && size(kept) > limit; ) {
      if (canDrop(kept[index])) kept.splice(index, 1);
      else index += 1;
    }
  };
  dropOldest((item) => item?.role !== "system" && !isLinkedChatsReference(item));
  dropOldest((item) => item?.role !== "system");
  return kept;
}

// The linked-chats reference: the user item that starts with the header
// buildProjectConversationReference writes.
function isLinkedChatsReference(item) {
  return (
    item?.role === "user" &&
    typeof item.content === "string" &&
    item.content.startsWith(PROJECT_REFERENCE_HEADER)
  );
}
export async function reservePublicAiCall(input, provider = "", model = "", credits = PUBLIC_REQUEST_CREDITS) {
  const scope = context.getStore();
  if (!scope) return;
  if (JSON.stringify(input || "").length > PUBLIC_CONTEXT_LIMIT)
    throw new ProductError(
      "Контекстът е твърде дълъг. Започни нов разговор.",
      "AI_CONTEXT_LIMIT",
      413,
    );
  if (scope.calls >= 6)
    throw new ProductError(
      "Достигнат е лимитът за опити в тази задача.",
      "AI_ATTEMPT_LIMIT",
      429,
    );
  scope.calls++;
  if (scope.free) return;
  await scope.reserve(scope.identity, credits, { provider, model });
}
// A drawn picture: about 1.1 US cents at cost, so two credits.
export const PUBLIC_IMAGE_CREDITS = 2;
export async function reservePublicAiImage(provider = "", model = "") {
  const scope = context.getStore();
  if (!scope) return;
  scope.calls++;
  await scope.reserve(scope.identity, PUBLIC_IMAGE_CREDITS, { provider, model });
}
// Turning speech into text is cheap: one credit per recording.
export const PUBLIC_VOICE_CREDITS = 1;
export async function reservePublicAiVoice(provider = "", model = "") {
  const scope = context.getStore();
  if (!scope) return;
  scope.calls++;
  await scope.reserve(scope.identity, PUBLIC_VOICE_CREDITS, { provider, model });
}
// A generated video (Gemini Omni Flash, up to 10 seconds at 720p with sound):
// about 1 US dollar at cost, so 100 units. Units are given back when the
// video could not be made. Returns a function that does that refund.
export const PUBLIC_VIDEO_CREDITS = 100;
export async function reservePublicAiVideo(provider = "", model = "") {
  const scope = context.getStore();
  if (!scope) return async () => false;
  scope.calls++;
  const reservationId = await scope.reserve(scope.identity, PUBLIC_VIDEO_CREDITS, { provider, model });
  let returned = false;
  return async () => {
    if (returned || !reservationId || !scope.refund) return false;
    returned = true;
    return scope.refund(scope.identity, reservationId);
  };
}
// A task for "Работа с Claude": several Claude turns in Anthropic's container,
// with skills and up to five web searches. About 5-8 US cents at most with
// the economical model, so 10 units. Units come back if nothing was made.
export const PUBLIC_CLAUDE_WORK_CREDITS = 10;
export async function reservePublicAiClaudeWork(provider = "", model = "") {
  const scope = context.getStore();
  if (!scope) return async () => false;
  scope.calls++;
  const reservationId = await scope.reserve(scope.identity, PUBLIC_CLAUDE_WORK_CREDITS, { provider, model });
  let returned = false;
  return async () => {
    if (returned || !reservationId || !scope.refund) return false;
    returned = true;
    return scope.refund(scope.identity, reservationId);
  };
}
