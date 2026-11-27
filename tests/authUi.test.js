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
  assert.match(html, /Novarium/u);
  assert.match(html, /id="publicTitle"/u);
  assert.match(html, /href="\/plans"/u);
  assert.match(html, /AI предлага, ти одобряваш/u);
  assert.match(html, /rel="canonical" href="https:\/\/cloudaicore\.com\/"/u);
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

test("new profiles are made only with Google; there is no password sign-up", () => {
  for (const id of ["registerForm", "registerName", "registerEmail", "registerPassword", "registerInviteCode", "showRegisterBtn"]) {
    assert.doesNotMatch(html, new RegExp(`id="${id}"`, "u"));
  }
  assert.doesNotMatch(app, /\/api\/auth\/register/u);
  assert.doesNotMatch(app, /handleRegistration|showRegisterForm/u);
  // Google comes first, the old password form is folded away below it.
  const google = html.indexOf('id="googleSignInBtn"');
  const password = html.indexOf('id="passwordSignIn"');
  assert.ok(google > 0 && google < password);
  assert.match(html, /<details class="auth-password" id="passwordSignIn">/u);
  assert.match(html, /Имаш профил с имейл и парола\?/u);
  assert.match(html, /„Продължи с Google“ със същия имейл/u);
  assert.match(html, /href="\/terms"/u);
  // Without Google the password form opens so nobody is locked out.
  assert.match(app, /session\.googleSignIn !== true\) \{\s*elements\.passwordSignIn\.open = true/u);
  assert.match(app, /AUTH_GOOGLE_PASSWORD_ACCOUNT/u);
  assert.doesNotMatch(
    `${html}\n${app}\n${css}`,
    /KAMCHIA-TEST-2026|SYNCHRON_TEST_INVITE_CODE=/u,
  );
});

test("sign-in errors name the failed action and HTTP status", () => {
  assert.match(app, /Входът не беше успешен \(HTTP \$\{response\.status\}\)/u);
  assert.match(app, /Невалиден отговор от услугата/u);
});

test("hides owner-only tools for member profiles and exposes logout", () => {
  assert.match(html, /id="toolsBtn"[^>]*data-owner-only/u);
  assert.match(html, /id="workCenterBtn"[^>]*data-owner-only/u);
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
