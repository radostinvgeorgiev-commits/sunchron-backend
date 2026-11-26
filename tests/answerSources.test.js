import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { describeAnswerSources } from "../src/services/answerSourcesService.js";

test("names only the person's own things that the answer actually uses", () => {
  const sources = describeAnswerSources({
    answer: "Рожденият ти ден е на 3 март, а договорът за наема изтича през декември.",
    memories: [
      { fact: "Рожденият ми ден е на 3 март" },
      { fact: "Обичам планински преходи през лятото" },
    ],
    filePassages: [
      { file: "Наем.pdf", text: "Договорът за наема изтича през декември 2026 година." },
      { file: "Рецепти.txt", text: "Баница с извара и яйца." },
    ],
    knowledge: [{ status: "approved", text: "Работи като архитект в София", sourceTitle: "Facebook" }],
  });
  assert.deepEqual(sources, [
    { kind: "file", label: "Наем.pdf" },
    { kind: "memory", label: "Рожденият ми ден е на 3 март" },
  ]);
});

test("an answer that uses nothing personal gets no source line", () => {
  assert.deepEqual(
    describeAnswerSources({
      answer: "Столицата на Франция е Париж.",
      memories: [{ fact: "Рожденият ми ден е на 3 март" }],
      filePassages: [{ file: "Наем.pdf", text: "Договорът за наема изтича през декември." }],
    }),
    [],
  );
  assert.deepEqual(describeAnswerSources({ answer: "" }), []);
});

test("the chat sends the sources with the finished answer and the page shows them", async () => {
  const [route, script] = await Promise.all([
    readFile(new URL("../src/routes/chat.js", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  ]);
  assert.match(route, /sources: describeAnswerSources\(\{\n\s+answer: fullReply,/u);
  assert.match(script, /showAnswerSources\(responseBubble, parsed\.data\?\.sources\)/u);
});
