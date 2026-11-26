import assert from "node:assert/strict";
import test from "node:test";
import { buildCouncilContext } from "../src/routes/chat.js";
import { PROJECT_BASE_CONTEXT } from "../src/config/projectIdentity.js";

test("the owner's Council gets the AI CORE project context", () => {
  const context = buildCouncilContext({ owner: true, avatarProfile: "Профил" });
  assert.match(context, new RegExp(PROJECT_BASE_CONTEXT[0].replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.doesNotMatch(context, /Профил/u);
});

test("a member's Council gets their own avatar profile, not the project facts", () => {
  const context = buildCouncilContext({
    owner: false,
    avatarProfile: "Казвам се Мария и уча медицина.",
    projectReference: "Проект: дипломна работа",
  });
  assert.match(context, /Мария/u);
  assert.match(context, /дипломна работа/u);
  for (const fact of PROJECT_BASE_CONTEXT.slice(0, 8)) {
    assert.equal(context.includes(fact), false);
  }
});
