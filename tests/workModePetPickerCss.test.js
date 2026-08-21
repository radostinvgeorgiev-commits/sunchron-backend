import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(
  new URL("../public/work-mode.css", import.meta.url),
  "utf8",
);

test("pet picker keeps visible selected and keyboard-focus states", () => {
  assert.match(
    css,
    /\.pet-choice\.active\{[^}]*background:#f0faf4/,
    "the selected pet has a non-border visual state",
  );
  assert.match(
    css,
    /\.pet-choice:focus-visible\{[^}]*outline:3px solid #0f6b45/,
    "keyboard focus has a visible outline",
  );
});
