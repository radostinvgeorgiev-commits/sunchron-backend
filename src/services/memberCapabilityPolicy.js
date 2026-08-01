const MEMBER_SAFE_CAPABILITIES = new Set(["memory.read", "web.search"]);

function roleOf(identity) {
  return typeof identity?.role === "string" ? identity.role.trim() : "";
}

export function isMemberIdentity(identity) {
  return ["member", "tester"].includes(roleOf(identity));
}

export function canPlanCapabilities(identity) {
  return roleOf(identity) === "owner" || isMemberIdentity(identity);
}

export function filterCapabilityRequestsForIdentity(
  requests = [],
  identity = null,
) {
  const safeRequests = Array.isArray(requests) ? requests : [];
  if (roleOf(identity) === "owner") return safeRequests;
  if (!isMemberIdentity(identity)) return [];
  return safeRequests.filter(({ capability }) =>
    MEMBER_SAFE_CAPABILITIES.has(capability),
  );
}

export function listMemberSafeCapabilities() {
  return [...MEMBER_SAFE_CAPABILITIES];
}
