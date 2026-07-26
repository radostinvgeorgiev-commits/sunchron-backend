import { evaluatePermission } from "../services/permissionService.js";
import {
  findToolsByCapability,
  registerCoreTools,
} from "./toolRegistry.js";

export class CapabilityError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.name = "CapabilityError";
    this.code = code;
    this.status = status;
  }
}

function resolvePermission(tool, capability) {
  const exactPermission = tool.permissions.find(
    (permission) => permission === capability,
  );
  return exactPermission || tool.permissions[0] || null;
}

export function resolveCapability(capability, options = {}) {
  if (typeof capability !== "string" || !capability.trim()) {
    throw new CapabilityError(
      "Липсва заявена способност.",
      "MISSING_CAPABILITY",
    );
  }

  registerCoreTools();
  const candidates = findToolsByCapability(capability.trim());
  if (!candidates.length) {
    throw new CapabilityError(
      `Няма активен инструмент за "${capability.trim()}".`,
      "CAPABILITY_UNAVAILABLE",
      503,
    );
  }

  const preferredProvider =
    typeof options.preferredProvider === "string"
      ? options.preferredProvider.trim()
      : "";
  const tool =
    candidates.find((candidate) => candidate.provider === preferredProvider) ||
    candidates[0];
  const permissionName = resolvePermission(tool, capability.trim());
  const permission = permissionName
    ? evaluatePermission(permissionName)
    : {
        action: "unknown",
        decision: "deny",
        risk: "unknown",
        reason: "Инструментът няма декларирано разрешение.",
      };

  if (permission.decision === "deny") {
    throw new CapabilityError(
      permission.reason,
      "CAPABILITY_PERMISSION_DENIED",
      403,
    );
  }

  return Object.freeze({
    capability: capability.trim(),
    tool,
    permission,
    requiresConfirmation:
      tool.requiresConfirmation || permission.decision === "confirm",
  });
}
