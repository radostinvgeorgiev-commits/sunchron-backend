const MEMBER_SAFE_CAPABILITIES = new Set([
  "memory.read",
  "web.search",
  "video.read",
  "places.search",
]);
// Reading the person's own Google, in their own chat, with their own
// connection. MCP clients do not get these.
const MEMBER_OWN_GOOGLE_CAPABILITIES = new Set([
  "calendar.read",
  "contacts.read",
  "files.read",
  "files.search",
  "mail.read",
  "mail.search",
  "youtube.channel",
]);
// Writing to the person's own Google: an event in their calendar, an email
// from their Gmail, a new contact. Each one is only prepared; it runs after
// the person sends the exact confirmation in their own chat.
const MEMBER_OWN_GOOGLE_WRITES = new Set([
  "calendar.write",
  "mail.send",
  "contacts.create",
]);

export function isMemberOwnGoogleWrite(capability) {
  return MEMBER_OWN_GOOGLE_WRITES.has(capability);
}

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
  { ownGoogle = false } = {},
) {
  const safeRequests = Array.isArray(requests) ? requests : [];
  if (roleOf(identity) === "owner") return safeRequests;
  if (!isMemberIdentity(identity)) return [];
  return safeRequests.filter(
    ({ capability }) =>
      MEMBER_SAFE_CAPABILITIES.has(capability) ||
      (ownGoogle &&
        (MEMBER_OWN_GOOGLE_CAPABILITIES.has(capability) ||
          MEMBER_OWN_GOOGLE_WRITES.has(capability))),
  );
}

export function listMemberSafeCapabilities() {
  return [...MEMBER_SAFE_CAPABILITIES];
}
