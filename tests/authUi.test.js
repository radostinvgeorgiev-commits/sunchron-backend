import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [html, app, css] = await Promise.all([
  readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  readFile(new URL("../public/auth.css", import.meta.url), "utf8"),
]);

test("renders a real login gate before the private application", () => {
  assert.match(html, /id="authGate"/u);
  assert.match(html, /id="loginForm"/u);
  assert.match(html, /type="email"/u);
  assert.match(html, /autocomplete="current-password"/u);
  assert.match(html, /id="appShell" hidden/u);
  assert.match(html, /href="\/api\/github\/connect"/u);
  assert.match(css, /\.app-shell\[hidden\]/u);
});

test("offers invite-only registration without embedding a code", () => {
  assert.match(html, /id="registerInviteCode"/u);
  assert.match(app, /registrationEnabled/u);
  assert.match(app, /\/api\/auth\/register/u);
  assert.doesNotMatch(
    `${html}\n${app}\n${css}`,
    /KAMCHIA-TEST-2026|SYNCHRON_TEST_INVITE_CODE=/u,
  );
});

test("hides owner tools for tester profiles and exposes logout", () => {
  assert.match(html, /id="toolsBtn"[^>]*data-owner-only/u);
  assert.match(html, /id="workCenterBtn"[^>]*data-owner-only/u);
  assert.match(html, /id="logoutBtn"/u);
  assert.match(app, /querySelectorAll\("\[data-owner-only\]"\)/u);
  assert.match(app, /user\?\.role === "owner"/u);
  assert.match(app, /\/api\/auth\/logout/u);
});
