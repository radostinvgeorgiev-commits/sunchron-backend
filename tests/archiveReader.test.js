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

test("Facebook: message requests count, a chat with a namesake stays on the device", () => {
  const me = mojibake("Радко Георгиев");
  const files = [
    ["x/personal_information/profile_information/profile_information.json", JSON.stringify({ profile_v2: { name: { full_name: me } } })],
    ["x/your_facebook_activity/messages/message_requests/maria_1/message_1.json", JSON.stringify({
      participants: [{ name: me }, { name: mojibake("Мария") }],
      messages: [{ sender_name: me, timestamp_ms: 1700000200000, content: mojibake("Благодаря за поканата.") }],
    })],
    ["x/your_facebook_activity/messages/inbox/group_1/message_1.json", JSON.stringify({
      participants: [{ name: me }, { name: me }, { name: mojibake("Иван") }],
      messages: [{ sender_name: me, timestamp_ms: 1700000300000, content: mojibake("Думи на съименника") }],
    })],
  ];
  const all = extractFacebook(files).map(({ text }) => text).join("\n");
  assert.match(all, /Благодаря за поканата\./u);
  assert.doesNotMatch(all, /съименника/u);
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
    ["claude/memories.json", JSON.stringify([{ conversations_memory: "Радко прави NovariumAI и пише на български." }])],
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

test("from Instagram come own captions and comments", async () => {
  const { extractInstagram } = await import("../public/archive-reader.mjs");
  const files = [
    ["x/your_instagram_activity/content/posts_1.json", JSON.stringify([
      { media: [{ uri: "a.jpg", creation_timestamp: 1700000000, title: mojibake("Залез над морето, обичам Варна.") }] },
      { title: mojibake("Три снимки от планината днес."), creation_timestamp: 1700001000, media: [{ title: "" }] },
    ])],
    ["x/your_instagram_activity/comments/post_comments_1.json", JSON.stringify([
      { string_map_data: { Comment: { value: mojibake("Страхотно място, ще дойда!") }, Time: { timestamp: 1700002000 } } },
    ])],
  ];
  const parts = extractInstagram(files);
  assert.deepEqual(parts.map(({ name }) => name), ["Instagram: моите публикации", "Instagram: моите коментари"]);
  const all = parts.map(({ text }) => text).join("\n");
  assert.match(all, /обичам Варна/u);
  assert.match(all, /Три снимки от планината/u);
  assert.match(all, /Страхотно място/u);
});

test("from LinkedIn come work, skills and own writing, without address or birth date", async () => {
  const { extractLinkedIn, parseCsv } = await import("../public/archive-reader.mjs");
  assert.deepEqual(parseCsv('a,"b, ""c""\nd",e\r\n1,2,3'), [["a", 'b, "c"\nd', "e"], ["1", "2", "3"]]);
  const files = [
    ["Profile.csv", 'First Name,Last Name,Address,Birth Date,Headline,Summary,Industry\nРадко,Георгиев,"ул. Тайна 1",1.1.1980,Основател на NovariumAI,"Правя личен AI аватар.",Software\n'],
    ["Positions.csv", "Company Name,Title,Description,Location,Started On,Finished On\nNovariumAI,Основател,Водя продукта,София,Mar 2024,\n"],
    ["Skills.csv", "Name\nПродукт\nПродажби\n"],
    ["Shares.csv", 'Date,ShareLink,ShareCommentary,SharedUrl,MediaUrl,Visibility\n2025-05-01 10:20:30,https://x,"Пуснахме нова версия, вижте я.",,,MEMBER_NETWORK\n'],
    ["Connections.csv", "Notes:\nFirst Name,Last Name\nИван,Иванов\n"],
  ];
  const parts = extractLinkedIn(files);
  assert.deepEqual(parts.map(({ name }) => name), ["LinkedIn: кой съм в работата", "LinkedIn: какво съм писал"]);
  const all = parts.map(({ text }) => text).join("\n");
  assert.match(all, /Основател на NovariumAI/u);
  assert.match(all, /Основател, NovariumAI/u);
  assert.match(all, /Умения: Продукт, Продажби/u);
  assert.match(all, /Пуснахме нова версия/u);
  assert.doesNotMatch(all, /Тайна|1980|Иванов/u);
});

test("from the X archive come own posts, not reposts", async () => {
  const { extractX } = await import("../public/archive-reader.mjs");
  const files = [["twitter/data/tweets.js", `window.YTD.tweets.part0 = ${JSON.stringify([
    { tweet: { full_text: "Днес пуснахме гласов разговор &amp; задачи.", created_at: "Wed Nov 26 10:00:00 +0000 2026" } },
    { tweet: { full_text: "RT @someone: чужд текст", created_at: "Wed Nov 26 11:00:00 +0000 2026" } },
  ])}`]];
  const [part] = extractX(files);
  assert.equal(part.name, "X: моите публикации");
  assert.match(part.text, /^2026-11-26 — Днес пуснахме гласов разговор & задачи\.$/u);
});

test("a LinkedIn zip goes through the whole reader", async () => {
  const zip = makeZip([
    ["Profile.csv", "First Name,Last Name,Headline,Summary\nМария,Иванова,Счетоводител,Помагам на малки фирми.\n"],
    ["Ignored.csv", "a,b\n1,2\n"],
  ]);
  const parts = await readPersonalArchive(zip);
  assert.equal(parts[0].name, "LinkedIn: кой съм в работата");
  assert.match(parts[0].text, /Счетоводител/u);
});
