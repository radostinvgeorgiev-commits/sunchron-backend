import assert from "node:assert/strict";
import test from "node:test";

import {
  consentEndedPage,
  isPassingSignInFault,
  opensAsPage,
  signInBusyPage,
  tooManyRequestsPage,
  wantsPage,
} from "../src/middleware/signInBusy.js";

const BROWSER_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

function fakeRequest(method, accept) {
  return {
    method,
    accepts(types) {
      if (accept === "*/*" || !accept) return types[0];
      return accept.startsWith("text/html") ? "html" : types[0];
    },
  };
}

test("only the sign-in's own passing fault counts, by code and status together", () => {
  assert.equal(isPassingSignInFault({ code: "AUTH_UNAVAILABLE", status: 503 }), true);
  assert.equal(isPassingSignInFault({ code: "AUTH_UNAVAILABLE", status: "503" }), true);
  assert.equal(isPassingSignInFault({ code: "AUTH_UNAVAILABLE", status: 401 }), false);
  assert.equal(isPassingSignInFault({ code: "AUTH_NOT_CONFIGURED", status: 503 }), false);
  assert.equal(isPassingSignInFault({ code: "TESTER_ACCESS_UNAVAILABLE", status: 503 }), false);
  assert.equal(isPassingSignInFault(null), false);
});

test("a page is what the browser opened itself; a reload repeats only a GET", () => {
  assert.equal(wantsPage(fakeRequest("GET", BROWSER_ACCEPT)), true);
  assert.equal(wantsPage(fakeRequest("POST", BROWSER_ACCEPT)), true);
  assert.equal(wantsPage(fakeRequest("GET", "*/*")), false);
  assert.equal(wantsPage({}), false);
  assert.equal(opensAsPage(fakeRequest("GET", BROWSER_ACCEPT)), true);
  assert.equal(opensAsPage(fakeRequest("POST", BROWSER_ACCEPT)), false);
  assert.equal(opensAsPage(fakeRequest("GET", "*/*")), false);
});

test("every way back is escaped: the link, the form and the texts", () => {
  const evil = `/oauth/authorize?a="><script>x()</script>&b='1'`;
  const linked = signInBusyPage(evil);
  assert.doesNotMatch(linked, /<script>/u);
  assert.match(
    linked,
    /<a href="\/oauth\/authorize\?a=&quot;&gt;&lt;script&gt;x\(\)&lt;\/script&gt;&amp;b=&#39;1&#39;">Опитай пак<\/a>/u,
  );

  const resent = signInBusyPage("", {
    resend: { action: "/oauth/authorize", fields: { consent_token: `t"><b>`, decision: "allow" } },
  });
  assert.match(resent, /<form method="post" action="\/oauth\/authorize">/u);
  assert.match(resent, /<input type="hidden" name="consent_token" value="t&quot;&gt;&lt;b&gt;">/u);
  assert.match(resent, /<input type="hidden" name="decision" value="allow">/u);
  assert.match(resent, /<button type="submit">Опитай пак<\/button>/u);
  assert.doesNotMatch(resent, /<b>/u);

  assert.match(signInBusyPage(), /Обнови тази страница след малко/u);
  const over = signInBusyPage("", { startOver: true });
  assert.match(over, /Затвори прозореца и започни свързването отново/u);
  assert.doesNotMatch(over, /Обнови тази страница|<form/u);
  assert.doesNotMatch(consentEndedPage("<i>x</i>"), /<i>/u);
  assert.match(consentEndedPage("Невалидно потвърждение."), /Затвори прозореца и започни свързването отново/u);
  assert.doesNotMatch(tooManyRequestsPage("<i>x</i>"), /<i>/u);
  assert.match(tooManyRequestsPage("Опитай отново след малко."), /<h1>Твърде много опити<\/h1>/u);
});
