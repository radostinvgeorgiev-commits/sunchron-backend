import { test } from "node:test";
import assert from "node:assert/strict";
import {
  askGoogleMaps,
  extractYoutubeUrl,
  isPlacesRequest,
  isYoutubeRequest,
  summarizeYoutubeVideo,
} from "../src/services/geminiToolsService.js";
import { detectCapabilityRequests } from "../src/routes/chat.js";
import { filterCapabilityRequestsForIdentity } from "../src/services/memberCapabilityPolicy.js";
import { listAssistantPresets } from "../src/services/assistantPresets.js";

const env = { GEMINI_API_KEY: "test-key", GEMINI_API_URL: "https://gemini.test/v1beta" };

function fakeFetch(reply, calls) {
  return async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return { ok: true, json: async () => reply };
  };
}

test("a YouTube link is found in the message, with or without extra words", () => {
  assert.equal(
    extractYoutubeUrl("Обобщи това видео: https://www.youtube.com/watch?v=dQw4w9WgXcQ."),
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  );
  assert.equal(extractYoutubeUrl("виж https://youtu.be/dQw4w9WgXcQ"), "https://youtu.be/dQw4w9WgXcQ");
  assert.equal(isYoutubeRequest("https://youtube.com/shorts/abcdef123"), true);
  assert.equal(isYoutubeRequest("гледах видео вчера"), false);
});

test("places questions go to the maps, other questions do not", () => {
  assert.equal(isPlacesRequest("Намери наблизо: аптека в Лозенец"), true);
  assert.equal(isPlacesRequest("Как да стигна до НДК от летището?"), true);
  assert.equal(isPlacesRequest("Препоръчай ресторант близо до Витошка"), true);
  assert.equal(isPlacesRequest("Find nearby: pharmacy"), true);
  assert.equal(isPlacesRequest("Напиши ми писмо до шефа"), false);
});

test("the video is read by Gemini from its link and the link is the source", async () => {
  const calls = [];
  const result = await summarizeYoutubeVideo("Обобщи това видео: https://youtu.be/dQw4w9WgXcQ", {
    env,
    fetchImpl: fakeFetch({ candidates: [{ content: { parts: [{ text: "Видеото е за..." }] } }] }, calls),
  });
  assert.equal(result.text, "Видеото е за...");
  assert.deepEqual(result.sources, [{ title: "Видеото в YouTube", url: "https://youtu.be/dQw4w9WgXcQ" }]);
  assert.equal(calls[0].body.contents[0].parts[0].fileData.fileUri, "https://youtu.be/dQw4w9WgXcQ");
  assert.match(calls[0].body.contents[0].parts[1].text, /Обобщи видеото/u);
});

test("places use Google Maps grounding and return the places as sources", async () => {
  const calls = [];
  const result = await askGoogleMaps("Намери наблизо: аптека в Лозенец", {
    env,
    fetchImpl: fakeFetch(
      {
        candidates: [
          {
            content: { parts: [{ text: "Аптека Х е на 300 м." }] },
            groundingMetadata: {
              groundingChunks: [
                { maps: { uri: "https://maps.google.com/?cid=1", title: "Аптека Х" } },
                { maps: { uri: "https://maps.google.com/?cid=1", title: "Аптека Х" } },
              ],
            },
          },
        ],
      },
      calls,
    ),
  });
  assert.deepEqual(calls[0].body.tools, [{ googleMaps: {} }]);
  assert.equal(result.text, "Аптека Х е на 300 м.");
  assert.deepEqual(result.sources, [{ title: "Аптека Х", url: "https://maps.google.com/?cid=1" }]);
});

test("without the Gemini key the tools say so instead of failing silently", async () => {
  await assert.rejects(() => askGoogleMaps("аптека наблизо", { env: {} }), /Gemini не е конфигуриран/u);
});

test("chat turns a video link and a places question into the tools, and members may use both", () => {
  const video = detectCapabilityRequests("Обобщи това видео: https://youtu.be/dQw4w9WgXcQ");
  assert.equal(video[0]?.capability, "video.read");
  const places = detectCapabilityRequests("Намери наблизо: аптека в Лозенец");
  assert.equal(places[0]?.capability, "places.search");
  const member = { role: "member" };
  assert.equal(filterCapabilityRequestsForIdentity(video, member).length, 1);
  assert.equal(filterCapabilityRequestsForIdentity(places, member).length, 1);
});

test("the chef and the coach show YouTube and maps among their tools", () => {
  const presets = Object.fromEntries(listAssistantPresets().map((item) => [item.id, item.tools.map(({ id }) => id)]));
  assert.ok(presets.chef.includes("youtube") && presets.chef.includes("maps"));
  assert.ok(presets.coach.includes("youtube") && presets.coach.includes("maps"));
});

test("a recipe or a picture with a place word is not a maps question", () => {
  assert.equal(isPlacesRequest("Покажи ми как се прави ресторантска паста"), false);
  assert.equal(isPlacesRequest("Препоръчай ресторантска рецепта"), false);
  assert.equal(isPlacesRequest("Покажи снимка на хотелска стая"), false);
  assert.equal(isPlacesRequest("Има ли аптека наблизо до НДК?"), true);
});

test("“не използвай инструменти” keeps the video and maps tools out", () => {
  const requests = detectCapabilityRequests(
    "Не използвай инструменти. Само обсъди https://youtu.be/dQw4w9WgXcQ",
  );
  assert.equal(requests.some(({ capability }) => capability === "video.read"), false);
});

test("when the maps are out of quota, the place question is answered from a web search", async () => {
  const searched = [];
  const result = await askGoogleMaps("Намери наблизо: аптека в Пловдив", {
    env,
    fetchImpl: async () => ({ ok: false, status: 429, text: async () => "RESOURCE_EXHAUSTED" }),
    fallbackSearch: async (query) => {
      searched.push(query);
      return { text: "Аптека Y, ул. Главна 1", sources: [{ title: "Y", url: "https://y.test" }] };
    },
  });
  assert.equal(result.text, "Аптека Y, ул. Главна 1");
  assert.match(searched[0], /аптека в Пловдив/u);
});

test("a city, the usual word forms and plain statements are read right", () => {
  assert.equal(isPlacesRequest("Препоръчай ресторант във Варна"), true);
  assert.equal(isPlacesRequest("Намери хотел в Пловдив"), true);
  assert.equal(isPlacesRequest("Намери кафене наблизо"), true);
  assert.equal(isPlacesRequest("Къде е аптеката?"), true);
  assert.equal(isPlacesRequest("Ресторантът беше близо до дома ми"), false);
  assert.equal(isPlacesRequest("Не искам ресторант наблизо"), false);
});
