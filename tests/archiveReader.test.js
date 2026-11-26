import test from "node:test";
import assert from "node:assert/strict";
import { makeZip } from "./ui/make-zip.mjs";

import {
  extractAiChats,
  extractFacebook,
  extractTakeout,
  fixFacebookText,
  listZipEntries,
  readPersonalArchive,
  readZipText,
} from "../public/archive-reader.mjs";

// How Facebook stores "Здравей": each UTF-8 byte as its own character.
const mojibake = (value) => String.fromCharCode(...Buffer.from(value, "utf8"));

test("zip entries are listed and read, compressed or not", async () => {
  const zip = makeZip([["a.txt", "Здравей, свят!"], ["b.txt", "plain", true]]);
  const entries = await listZipEntries(zip);
  assert.deepEqual(entries.map(({ name }) => name), ["a.txt", "b.txt"]);
  assert.equal(await readZipText(zip, entries[0]), "Здравей, свят!");
  assert.equal(await readZipText(zip, entries[1]), "plain");
  await assert.rejects(() => listZipEntries(new Blob(["not a zip"])), /не е \.zip/u);
});

test("Facebook text encoding is repaired", () => {
  assert.equal(fixFacebookText(mojibake("Радко пише")), "Радко пише");
  assert.equal(fixFacebookText("already fine"), "already fine");
});

test("from Facebook only the person's own posts, comments and messages are kept", () => {
  const me = mojibake("Радко Георгиев");
  const files = [
    ["x/personal_information/profile_information/profile_information.json", JSON.stringify({ profile_v2: { name: { full_name: me } } })],
    ["x/your_facebook_activity/posts/your_posts__check_ins__photos_and_videos_1.json", JSON.stringify([
      { timestamp: 1700000000, data: [{ post: mojibake("Днес открих нещо ново.") }] },
    ])],
    ["x/your_facebook_activity/comments_and_reactions/comments.json", JSON.stringify({ comments_v2: [
      { timestamp: 1700000100, data: [{ comment: { comment: mojibake("Браво, много хубава снимка!") } }] },
    ] })],
    ["x/your_facebook_activity/messages/inbox/ivan_1/message_1.json", JSON.stringify({ messages: [
      { sender_name: me, timestamp_ms: 1700000200000, content: mojibake("Ще дойда в 7.") },
      { sender_name: mojibake("Иван"), timestamp_ms: 1700000300000, content: mojibake("Тайна на Иван") },
    ] })],
  ];
  const parts = extractFacebook(files);
  const all = parts.map(({ text }) => text).join("\n");
  assert.deepEqual(parts.map(({ name }) => name), [
    "Facebook: моите публикации",
    "Facebook: моите коментари",
    "Facebook: какво съм писал в чатове",
  ]);
  assert.match(all, /Днес открих нещо ново\./u);
  assert.match(all, /Ще дойда в 7\./u);
  assert.match(all, /много хубава снимка/u);
  assert.doesNotMatch(all, /Тайна на Иван/u);
});

test("from Google Takeout come Keep notes and calendar events", () => {
  const parts = extractTakeout([
    ["Takeout/Keep/Бележка.json", JSON.stringify({ title: "Пазар", textContent: "мляко и хляб за седмицата", userEditedTimestampUsec: 1.7e15 })],
    ["Takeout/Keep/Кошче.json", JSON.stringify({ title: "Стара", textContent: "изтрита бележка", isTrashed: true })],
    ["Takeout/Calendar/Радко.ics", "BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:20261127T090000Z\nSUMMARY:Среща с банката за кредита\nEND:VEVENT\nEND:VCALENDAR"],
  ]);
  const all = parts.map(({ text }) => text).join("\n");
  assert.match(all, /мляко и хляб/u);
  assert.doesNotMatch(all, /изтрита бележка/u);
  assert.match(all, /2026-11-27 — Среща с банката/u);
});

test("the whole archive flow reads only the files that matter", async () => {
  const zip = makeZip([
    ["Takeout/Keep/Бележка.json", JSON.stringify({ title: "Идея", textContent: "Аватар за всеки човек, безплатно.", userEditedTimestampUsec: 1.7e15 })],
    ["Takeout/Fit/огромен.json", "x".repeat(1000)],
  ]);
  const seen = [];
  const parts = await readPersonalArchive(zip, (done, total) => seen.push(`${done}/${total}`));
  assert.deepEqual(seen, ["1/1"]);
  assert.equal(parts[0].name, "Google Keep: моите бележки");
  await assert.rejects(() => readPersonalArchive(makeZip([["other.txt", "nothing"]])), /JSON/u);
});

test("from ChatGPT and Claude exports only the person's own words are kept", () => {
  const parts = extractAiChats([
    ["conversations.json", JSON.stringify([
      {
        title: "Ремонт",
        create_time: 1700000000,
        mapping: {
          a: { message: { author: { role: "user" }, create_time: 1700000000, content: { parts: ["Как да боядисам стената в банята?", { asset: "img" }] } } },
          b: { message: { author: { role: "assistant" }, content: { parts: ["Отговор на ChatGPT, който не трябва да се пази"] } } },
          c: { message: null },
        },
      },
    ])],
    ["claude/conversations.json", JSON.stringify([
      {
        name: "Бизнес план",
        created_at: "2026-10-01T10:00:00Z",
        chat_messages: [
          { sender: "human", created_at: "2026-10-01T10:00:00Z", text: "", content: [{ type: "text", text: "Помогни ми с плана за кафенето." }] },
          { sender: "assistant", text: "Отговор на Claude, който не трябва да се пази" },
        ],
      },
    ])],
    ["claude/memories.json", JSON.stringify([{ conversations_memory: "Радко прави AI CORE и пише на български." }])],
  ]);
  const all = parts.map(({ text }) => text).join("\n");
  assert.deepEqual(parts.map(({ name }) => name), [
    "ChatGPT: какво съм писал",
    "Claude: какво съм писал",
    "Claude: какво е запомнил за мен",
  ]);
  assert.match(all, /\[Ремонт\] Как да боядисам стената/u);
  assert.match(all, /2026-10-01 — \[Бизнес план\] Помогни ми с плана/u);
  assert.match(all, /пише на български/u);
  assert.doesNotMatch(all, /не трябва да се пази/u);
});

test("a ChatGPT export zip goes through the whole flow", async () => {
  const zip = makeZip([
    ["conversations.json", JSON.stringify([{ title: "Идея", mapping: { a: { message: { author: { role: "user" }, create_time: 1.7e9, content: { parts: ["Искам аватар, който ме познава."] } } } } }])],
    ["chat.html", "<html>big page</html>"],
  ]);
  const parts = await readPersonalArchive(zip);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].name, "ChatGPT: какво съм писал");
  assert.match(parts[0].text, /Искам аватар/u);
});
