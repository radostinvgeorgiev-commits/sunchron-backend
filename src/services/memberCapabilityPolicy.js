const MEMBER_SAFE_CAPABILITIES = new Set([
  "memory.read",
  "web.search",
  "video.read",
  "places.search",
  // „Моите задачи“: every person's own list, kept under their own account.
  "todos.read",
  "todos.add",
  // The person's own memory, searched under their own account.
  "memory.search",
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
// from their Gmail, a new contact, and a draft or a letter moved to the bin
// once a step for them is prepared. Their own command runs an event, a
// contact or an email to an address they typed at once (chat.js,
// ownCommandWriteOf). Today the draft and the bin are pressed in the Gmail
// panel („Чернова от мое име“, „В кошчето“ with a second press,
// googleDriveRouter.js), with the person's own connection. The open tree
// (RADKO 28.11 06:21, 06:36, 06:49): each person's own branch, down to the
// server, with every tool reading and writing their own data and none on
// anyone else's.
const MEMBER_OWN_GOOGLE_WRITES = new Set([
  "calendar.write",
  "mail.send",
  "mail.draft",
  "mail.delete",
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
