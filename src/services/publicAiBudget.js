import { AsyncLocalStorage } from "node:async_hooks";
import { getProductPlansService, ProductError } from "./productPlansService.js";
const context = new AsyncLocalStorage();
export function createPublicAiBudgetContext({
  reserve = (identity, credits, details) =>
    getProductPlansService().reserve(identity, credits, details),
} = {}) {
  return (req, _res, next) => {
    if (req.owner?.role === "owner") return next();
    return context.run({ identity: req.owner, calls: 0, reserve }, next);
  };
}
export const publicAiBudgetContext = createPublicAiBudgetContext();
export function publicAiOutputLimit() {
  return context.getStore() ? 1024 : null;
}
export async function reservePublicAiCall(input, provider = "", model = "") {
  const scope = context.getStore();
  if (!scope) return;
  if (JSON.stringify(input || "").length > 32000)
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
  await scope.reserve(scope.identity, 3, { provider, model });
}
