import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CHAT_MODEL_CHOICES,
  resolveChatModelChoice,
  resolveWorkAgentModel,
  resolveWorkAgentProvider,
} from "../src/services/workModeService.js";

test("chat model picker offers auto plus economical models that map to real providers", () => {
  assert.equal(CHAT_MODEL_CHOICES[0].id, "auto");
  for (const choice of CHAT_MODEL_CHOICES.slice(1)) {
    assert.ok(resolveWorkAgentProvider(choice.id), choice.id);
    assert.ok(resolveWorkAgentModel(choice.id), choice.id);
  }
});

test("only known, non-auto model ids are accepted from the chat body", () => {
  assert.equal(resolveChatModelChoice("gemini-2.5-flash-lite"), "gemini-2.5-flash-lite");
  assert.equal(resolveChatModelChoice("auto"), undefined);
  assert.equal(resolveChatModelChoice("grok-4.5"), undefined);
  assert.equal(resolveChatModelChoice("gpt-5.6-sol"), undefined);
  assert.equal(resolveChatModelChoice({}), undefined);
  assert.equal(resolveChatModelChoice(undefined), undefined);
});

test("chat route reads the picked model, keeps Work mode on its agent and falls back to default", () => {
  const source = readFileSync(new URL("../src/routes/chat.js", import.meta.url), "utf8");
  assert.match(source, /router\.get\("\/models"/);
  assert.match(source, /interactionMode === "work" \? undefined : resolveChatModelChoice\(model\)/);
  assert.match(source, /if \(chatModelChoice\) \{/);
});

test("the header has a model picker and each message sends the choice", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const ui = readFileSync(new URL("../public/ui-refresh.js", import.meta.url), "utf8");
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(html, /id="modelPickerBtn"/);
  assert.match(html, /id="modelPickerMenu"/);
  assert.match(ui, /fetch\("\/chat\/models"/);
  assert.match(ui, /aiCoreChatModel/);
  assert.match(app, /model: modelOverride \|\| globalThis\.SynchronUi\?\.chatModel\?\.\(\) \|\| "auto"/);
});
