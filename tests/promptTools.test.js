import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ASSISTANT_PRESETS,
  listAssistantPresets,
  resolveAssistantPreset,
} from "../src/services/assistantPresets.js";
import { buildAvatarMessages } from "../src/routes/chat.js";

test("assistant presets resolve only known ids and the list hides instructions", () => {
  assert.ok(ASSISTANT_PRESETS.length >= 5);
  assert.equal(resolveAssistantPreset("lawyer")?.label, "Юрист");
  assert.equal(resolveAssistantPreset("hacker"), null);
  assert.equal(resolveAssistantPreset({}), null);
  for (const item of listAssistantPresets()) assert.equal(item.instruction, undefined);
});

test("the chosen assistant adds its role to the system prompt", () => {
  const lawyer = resolveAssistantPreset("lawyer");
  const [system] = buildAvatarMessages([], [], "Здравей", undefined, {
    mode: "chat",
    workContext: null,
    assistant: lawyer,
  });
  assert.match(system.content, /юридически помощник/u);
  const [plain] = buildAvatarMessages([], [], "Здравей");
  assert.doesNotMatch(plain.content, /юридически помощник/u);
});

test("the chat route serves the list and ignores the assistant in Work mode", () => {
  const chat = readFileSync(new URL("../src/routes/chat.js", import.meta.url), "utf8");
  assert.match(chat, /router\.get\("\/assistants"/);
  assert.match(chat, /interactionMode === "work"\s*\? null\s*: resolveAssistantPreset\(assistant\)/);
});

test("the page has the assistant picker and the / prompts", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const tools = readFileSync(new URL("../public/prompt-tools.js", import.meta.url), "utf8");
  const ui = readFileSync(new URL("../public/ui-refresh.js", import.meta.url), "utf8");
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(html, /src="\/prompt-tools\.js/);
  // The specialist is picked at the top next to the model, not from "+".
  assert.doesNotMatch(ui, /data-plus="assistant"/);
  assert.match(tools, /id = "assistantPickerBtn"/);
  assert.match(tools, /fetch\("\/chat\/assistants"/);
  assert.match(tools, /className = "slash-menu"/);
  assert.match(app, /assistant: globalThis\.SynchronUi\.assistant\(\)/);
});

test("the new assistants exist and the health ones point to real help", () => {
  for (const id of ["architect", "doctor", "accountant", "coach", "chef", "listener"]) {
    assert.ok(resolveAssistantPreset(id), id);
  }
  assert.match(resolveAssistantPreset("doctor").instruction, /без да поставяш диагноза/u);
  assert.match(resolveAssistantPreset("doctor").instruction, /112/u);
  assert.match(resolveAssistantPreset("listener").instruction, /112/u);
  const tools = readFileSync(new URL("../public/prompt-tools.js", import.meta.url), "utf8");
  assert.doesNotMatch(tools, /assistant-row/u);
});

test("every specialist lists its tools, and the role knows about them", async () => {
  const { ASSISTANT_TOOLS } = await import("../src/services/assistantPresets.js");
  for (const item of listAssistantPresets()) {
    assert.ok(item.tools.length > 0, item.id);
    for (const tool of item.tools) assert.ok(ASSISTANT_TOOLS[tool.id], `${item.id}:${tool.id}`);
  }
  const accountant = listAssistantPresets().find(({ id }) => id === "accountant");
  assert.deepEqual(accountant.tools.map(({ id }) => id), ["web", "drive", "gmail", "files"]);
  assert.equal(accountant.tools.find(({ id }) => id === "gmail").needs, "google");
  assert.match(resolveAssistantPreset("chef").instruction, /Моите задачи/u);
  assert.match(resolveAssistantPreset("accountant").instruction, /Gmail/u);
});
