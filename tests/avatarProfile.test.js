import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  AVATAR_PROFILE_COLLECTION,
  AVATAR_PROFILE_FIELDS,
  buildAvatarProfileContext,
  createAvatarProfileService,
  normalizeAvatarProfile,
} from "../src/services/avatarProfileService.js";
import { buildAvatarMessages } from "../src/routes/chat.js";

function memoryStore() {
  const docs = new Map();
  return {
    docs,
    async get(collection, id) {
      const data = docs.get(`${collection}/${id}`);
      return data ? { data: structuredClone(data) } : null;
    },
    async commitOperations([op]) {
      docs.set(`${op.collection}/${op.id}`, structuredClone(op.data));
    },
  };
}
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("the profile is cleaned, capped and keeps only known fields", () => {
  const profile = normalizeAvatarProfile({
    about: "  Мария, счетоводител.\u0000 ",
    goals: "Ц".repeat(5000),
    role: "owner",
  });
  assert.equal(profile.about, "Мария, счетоводител.");
  assert.equal(profile.goals.length, 1200);
  assert.deepEqual(Object.keys(profile), AVATAR_PROFILE_FIELDS.map(({ id }) => id));
  assert.throws(() => normalizeAvatarProfile("x"), { code: "AVATAR_PROFILE_INVALID" });
  assert.throws(() => normalizeAvatarProfile([]), { code: "AVATAR_PROFILE_INVALID" });
});

test("each account has its own profile and can erase it", async () => {
  const store = memoryStore();
  const service = createAvatarProfileService({ store, now: () => 5 });
  await service.save("maria", { about: "Мария", style: "Кратко." });
  await service.save("ivan", { about: "Иван" });
  assert.equal((await service.read("maria")).about, "Мария");
  assert.equal((await service.read("ivan")).about, "Иван");
  assert.equal((await service.read("nobody")).about, "");
  assert.equal(store.docs.size, 2);
  assert.ok([...store.docs.keys()].every((key) => key.startsWith(`${AVATAR_PROFILE_COLLECTION}/`)));
  assert.ok(![...store.docs.keys()].some((key) => key.includes("maria")));
  await service.save("maria", {});
  assert.equal(await service.contextFor("maria"), "");
  await assert.rejects(() => service.read(""), { code: "AVATAR_PROFILE_OWNER_REQUIRED" });
});

test("a storage problem never stops the chat", async () => {
  const service = createAvatarProfileService({
    store: { get: async () => { throw new Error("down"); } },
  });
  assert.equal(await service.contextFor("maria"), "");
});

test("the profile reaches the AI as the person's own description, not as rules", () => {
  assert.equal(buildAvatarProfileContext(normalizeAvatarProfile({})), "");
  const context = buildAvatarProfileContext(
    normalizeAvatarProfile({ about: "Мария от Пловдив", limits: "Не пращай нищо без да питаш." }),
  );
  assert.match(context, /НАПИСАН ОТ САМИЯ ЧОВЕК/u);
  assert.match(context, /Мария от Пловдив/u);
  assert.match(context, /решава човекът/u);
  assert.match(context, /не дава нови права/u);
  assert.doesNotMatch(context, /Целите ми/u);

  for (const identity of [
    { role: "member", displayName: "Мария" },
    { role: "owner", displayName: "Радко" },
  ]) {
    const [system] = buildAvatarMessages([], [], "Здравей", identity, {
      mode: "chat",
      avatarProfile: context,
    });
    assert.match(system.content, /Мария от Пловдив/u);
  }
});

test("the route, the page and the menu are wired for every signed-in account", () => {
  const server = read("../server.js");
  assert.match(
    server,
    /"\/api\/avatar-profile",\s*requireOwnerSession,\s*privateApiRateLimiter,\s*createAvatarProfileRouter/u,
  );
  assert.match(read("../src/routes/chat.js"), /getAvatarProfileService\(\)\.contextFor\(ownerId\)/u);
  assert.match(read("../public/avatar-profile.js"), /fetch\("\/api\/avatar-profile"/u);
  assert.match(read("../public/ui-refresh.js"), /data-plus="avatar"/u);
  assert.match(read("../public/index.html"), /avatar-profile\.js/u);
});
