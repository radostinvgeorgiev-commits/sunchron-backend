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
    // The main scopes plus YouTube, so the new token keeps everything. A
    // refusal by Google changes nothing: the old connection stays.
    assert.equal(withYoutube, `${plain} https://www.googleapis.com/auth/youtube.readonly`);
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
  assert.equal(isOwnYoutubeChannelRequest("Show my YouTube channel and my latest videos"), true);
  assert.equal(isOwnYoutubeChannelRequest("How many subscribers do I have on YouTube?"), true);
  assert.equal(isOwnYoutubeChannelRequest("Summarize this YouTube video https://youtu.be/abc"), false);
  const member = { role: "member" };
  const request = [{ capability: "youtube.channel" }];
  assert.equal(filterCapabilityRequestsForIdentity(request, member, { ownGoogle: true }).length, 1);
  assert.equal(filterCapabilityRequestsForIdentity(request, member, { ownGoogle: false }).length, 0);
});

test("the latest comments on the person's own videos, with who is still waiting", async () => {
  const { getYoutubeRecentComments } = await import("../src/services/googleDriveService.js");
  const { formatYoutubeComments } = await import("../src/tools/capabilityEngine.js");
  const id = await createSession({ access_token: "token", expires_in: 3600 });
  const urls = [];
  const result = await getYoutubeRecentComments(id, 5, async (url) => {
    urls.push(String(url));
    if (String(url).includes("/channels?")) return json({ items: [{ id: "UC1", snippet: { title: "Радко" } }] });
    return json({
      items: [
        { snippet: { videoId: "abc123XYZ_0", totalReplyCount: 0, topLevelComment: { id: "c1", snippet: { authorDisplayName: "Иван", textOriginal: "Как се ползва?", likeCount: 2, publishedAt: "2026-11-27T10:00:00Z", authorChannelId: { value: "UCx" } } } } },
        { snippet: { videoId: "abc123XYZ_0", totalReplyCount: 1, topLevelComment: { id: "c2", snippet: { authorDisplayName: "Мария", textOriginal: "Супер!", publishedAt: "2026-11-26T10:00:00Z", authorChannelId: { value: "UCy" } } } }, replies: { comments: [{ snippet: { authorChannelId: { value: "UC1" } } }] } },
        { snippet: { videoId: "bad id", topLevelComment: { id: "c3", snippet: {} } } },
      ],
    });
  });
  assert.match(urls[1], /commentThreads\?part=snippet,replies&order=time&textFormat=plainText&maxResults=5&allThreadsRelatedToChannelId=UC1$/u);
  assert.equal(result.comments.length, 2);
  assert.deepEqual(result.comments.map((c) => [c.author, c.answered]), [["Иван", false], ["Мария", true]]);
  assert.equal(result.comments[0].commentUrl, "https://www.youtube.com/watch?v=abc123XYZ_0&lc=c1");
  const text = formatYoutubeComments(result);
  assert.match(text, /без отговор от канала: 1/u);
  assert.match(text, /Иван \(2026-11-27, без отговор\): „Как се ползва\?“/u);
  assert.match(text, /нищо не е публикувано/u);
  assert.match(formatYoutubeComments({ channel: { title: "Р" }, comments: [] }), /Още няма коментари/u);
});

test("chat reads YouTube comments when the person asks about them", async () => {
  const { isOwnYoutubeCommentsRequest } = await import("../src/routes/chat.js");
  assert.equal(isOwnYoutubeCommentsRequest("Какво ми пишат в коментарите в YouTube?"), true);
  assert.equal(isOwnYoutubeCommentsRequest("помогни ми да отговоря на коментарите в ютюб"), true);
  assert.equal(isOwnYoutubeCommentsRequest("Any new comments on my YouTube videos?"), true);
  assert.equal(isOwnYoutubeCommentsRequest("обобщи коментарите под https://youtu.be/abc"), false);
  assert.equal(isOwnYoutubeCommentsRequest("Как върви моят YouTube канал?"), false);
  const member = { role: "member" };
  assert.equal(filterCapabilityRequestsForIdentity([{ capability: "youtube.comments" }], member, { ownGoogle: true }).length, 1);
});
