import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAuthorizationUrl,
  createSession,
  getYoutubeChannelSummary,
} from "../src/services/googleDriveService.js";
import { checkGoogleServices } from "../src/routes/googleDriveRouter.js";
import { isOwnYoutubeChannelRequest } from "../src/routes/chat.js";
import { filterCapabilityRequestsForIdentity } from "../src/services/memberCapabilityPolicy.js";

const json = (data, status = 200) => new Response(JSON.stringify(data), { status });

test("YouTube is asked for only when the person turns it on", () => {
  const saved = { ...process.env };
  Object.assign(process.env, {
    GOOGLE_CLIENT_ID: "client",
    GOOGLE_CLIENT_SECRET: "secret",
    GOOGLE_REDIRECT_URI: "https://example.test/callback",
  });
  try {
    const plain = new URL(buildAuthorizationUrl("s")).searchParams.get("scope");
    const withYoutube = new URL(buildAuthorizationUrl("s", ["youtube"])).searchParams.get("scope");
    const unknown = new URL(buildAuthorizationUrl("s", ["admin"])).searchParams.get("scope");
    assert.doesNotMatch(plain, /youtube/u);
    // Its own small consent: sign-in plus YouTube only, so a refusal by
    // Google can never break the main Google connection.
    assert.equal(withYoutube, "openid email https://www.googleapis.com/auth/youtube.readonly");
    assert.equal(unknown, plain);
  } finally {
    for (const key of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

test("the channel summary reads totals and the latest videos", async () => {
  const id = await createSession({ access_token: "token", expires_in: 3600 });
  const urls = [];
  const summary = await getYoutubeChannelSummary(id, 2, async (url) => {
    urls.push(String(url));
    if (String(url).includes("/channels?")) {
      return json({ items: [{ id: "UC1", snippet: { title: "Радко" }, statistics: { subscriberCount: "120", viewCount: "5000", videoCount: "7" }, contentDetails: { relatedPlaylists: { uploads: "UU1" } } }] });
    }
    if (String(url).includes("/playlistItems?")) {
      return json({ items: [{ contentDetails: { videoId: "abc123XYZ_0" } }] });
    }
    return json({ items: [{ id: "abc123XYZ_0", snippet: { title: "Първо видео", publishedAt: "2026-11-20T10:00:00Z" }, statistics: { viewCount: "300", likeCount: "12", commentCount: "3" } }] });
  });
  assert.match(urls[0], /channels\?part=snippet,statistics,contentDetails&mine=true$/u);
  assert.match(urls[1], /maxResults=2&playlistId=UU1$/u);
  assert.deepEqual(summary.channel, { id: "UC1", title: "Радко", subscribers: 120, views: 5000, videos: 7, url: "https://www.youtube.com/channel/UC1" });
  assert.deepEqual(summary.videos, [{ id: "abc123XYZ_0", title: "Първо видео", publishedAt: "2026-11-20T10:00:00Z", views: 300, likes: 12, comments: 3, url: "https://www.youtube.com/watch?v=abc123XYZ_0" }]);
});

test("no permission yet gives a YouTube connect link, not a broken tool", async () => {
  const id = await createSession({ access_token: "token", expires_in: 3600 });
  await assert.rejects(
    getYoutubeChannelSummary(id, 1, async () => json({ error: { message: "insufficient authentication scopes", errors: [{ reason: "insufficientPermissions" }] } }, 403)),
    (error) => error.code === "GOOGLE_SCOPE_REQUIRED" && /connect\?add=youtube/u.test(error.message),
  );
  const results = await checkGoogleServices(id, {
    youtube: async () => {
      const error = new (await import("../src/services/googleDriveService.js")).GoogleDriveError("x", 403, "GOOGLE_SCOPE_REQUIRED");
      throw error;
    },
  });
  assert.deepEqual(results.youtube, { ok: false, connect: "/api/google/connect?add=youtube", reason: "Още не е разрешен." });
});

test("chat asks for the channel only when the person means their own", () => {
  assert.equal(isOwnYoutubeChannelRequest("Как върви моят YouTube канал?"), true);
  assert.equal(isOwnYoutubeChannelRequest("колко гледания имат видеата ми в ютюб"), true);
  assert.equal(isOwnYoutubeChannelRequest("обобщи това видео https://youtu.be/abc"), false);
  assert.equal(isOwnYoutubeChannelRequest("моят канал в Telegram"), false);
  const member = { role: "member" };
  const request = [{ capability: "youtube.channel" }];
  assert.equal(filterCapabilityRequestsForIdentity(request, member, { ownGoogle: true }).length, 1);
  assert.equal(filterCapabilityRequestsForIdentity(request, member, { ownGoogle: false }).length, 0);
});
