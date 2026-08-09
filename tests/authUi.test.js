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
  assert.match(html, /SYNCHRON-X/u);
  assert.match(html, /ЛИЧНА AI ОПЕРАЦИОННА СИСТЕМА/u);
  assert.match(html, /Един AI център за разговори, памет и реална работа/u);
  assert.match(html, /Ти контролираш паметта/u);
  assert.match(html, /AI предлага, ти одобряваш/u);
  assert.match(html, /rel="canonical" href="https:\/\/synchron\.foundation\/"/u);
  assert.match(html, /property="og:title"/u);
  assert.match(
    html,
    /id="loginForm"[\s\S]{0,160}method="post"[\s\S]{0,80}action="\/api\/auth\/login"/u,
  );
  assert.match(html, /type="email"/u);
  assert.match(html, /autocomplete="current-password"/u);
  assert.match(html, /id="appShell" hidden/u);
  assert.match(html, /href="\/api\/github\/connect"/u);
  assert.match(html, /<details class="auth-owner">/u);
  assert.match(css, /\.app-shell\[hidden\]/u);
  assert.match(css, /\.auth-form\[hidden\]/u);
  assert.match(css, /\.auth-link\[hidden\]/u);
});

test("offers invite-protected registration with safe POST fallback", () => {
  assert.match(html, /id="registerName"/u);
  assert.match(html, /id="registerEmail"/u);
  assert.match(html, /id="registerPassword"/u);
  assert.match(html, /id="registerInviteCode"/u);
  assert.match(html, /Код за ранен достъп/u);
  assert.match(
    html,
    /id="registerForm"[\s\S]{0,160}method="post"[\s\S]{0,80}action="\/api\/auth\/register"/u,
  );
  assert.match(
    html,
    /id="showRegisterBtn"[^>]*href="\/register"/u,
  );
  assert.match(app, /registrationEnabled/u);
  assert.match(app, /\/api\/auth\/register/u);
  assert.doesNotMatch(
    `${html}\n${app}\n${css}`,
    /KAMCHIA-TEST-2026|SYNCHRON_TEST_INVITE_CODE=/u,
  );
});

test("registration sends the user-entered invitation code without embedding it", () => {
  assert.match(app, /displayName: elements\.registerName\.value/u);
  assert.match(app, /email: elements\.registerEmail\.value/u);
  assert.match(app, /password: elements\.registerPassword\.value/u);
  assert.match(app, /inviteCode: elements\.registerInviteCode\.value/u);
  assert.match(app, /registerInviteCode\.value = ""/u);
  assert.doesNotMatch(
    `${html}\n${app}\n${css}`,
    /KAMCHIA-TEST-2026|SYNCHRON_TEST_INVITE_CODE=/u,
  );
});

test("registration errors identify the failed action and HTTP status", () => {
  assert.match(app, /path\.endsWith\("\/register"\)/u);
  assert.match(app, /Регистрацията/u);
  assert.match(app, /HTTP \$\{response\.status\}/u);
  assert.match(app, /Невалиден отговор от услугата/u);
});

test("direct registration address opens the registration form", () => {
  assert.match(app, /const REGISTRATION_PATH = "\/register"/u);
  assert.match(app, /isDirectRegistrationPage\(\)/u);
  assert.match(
    app,
    /state\.registrationEnabled && isDirectRegistrationPage\(\)/u,
  );
  assert.match(app, /showRegisterForm\(\)/u);
});

test("hides owner-only tools for member profiles and exposes logout", () => {
  assert.match(html, /id="toolsBtn"[^>]*data-owner-only/u);
  assert.match(html, /id="workCenterBtn"[^>]*data-owner-only/u);
  assert.match(
    html,
    /data-command="connections"[^>]*data-owner-only/u,
  );
  assert.match(html, /id="logoutBtn"/u);
  assert.match(app, /querySelectorAll\("\[data-owner-only\]"\)/u);
  assert.match(app, /user\?\.role === "owner"/u);
  assert.match(app, /isOwner \? "owner" : "member"/u);
  assert.match(app, /\/api\/auth\/logout/u);
});

test("the profile ellipsis opens clear status and logout actions", () => {
  assert.match(
    html,
    /id="toggleStatusBtn"[\s\S]*aria-controls="profileActions"/u,
  );
  assert.match(html, /id="profileStatusBtn"[\s\S]*Състояние и настройки/u);
  assert.match(html, /id="sidebarLogoutBtn"[\s\S]*Излез от профила/u);
  assert.match(
    app,
    /toggleStatusBtn\.addEventListener\("click", toggleProfileActions\)/u,
  );
  assert.match(
    app,
    /sidebarLogoutBtn\.addEventListener\("click", handleLogout\)/u,
  );
  assert.match(css, /\.profile-actions\[hidden\]/u);
});

test("shows the authenticated profile before the long navigation list", () => {
  const profilePosition = html.indexOf('id="toggleStatusBtn"');
  const navigationPosition = html.indexOf('class="sidebar-nav"');
  const conversationPosition = html.indexOf('id="conversationList"');

  assert.ok(profilePosition > 0);
  assert.ok(profilePosition < navigationPosition);
  assert.ok(profilePosition < conversationPosition);
  assert.match(html, /id="profileRole">Проверка на профила/u);
});
