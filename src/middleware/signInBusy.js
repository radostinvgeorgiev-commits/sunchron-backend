// A passing fault while the sign-in is checked (no answer from Google, too
// many requests, a fault at Google, or the account check's record out of
// reach): resolveUserSession keeps the sign-in and throws a UserAuthError 503
// AUTH_UNAVAILABLE. A page opened in the browser (a connect link, the return
// from Google, the connector's consent) then says to try again in a moment,
// never a bare JSON error (RADKO 28.11: Safari saved one as connect.json).
export function isPassingSignInFault(error) {
  return error?.code === "AUTH_UNAVAILABLE" && Number(error?.status) === 503;
}

// A request the browser made to show a page (a link it opened, a form it
// sent), not one of the site's own fetches, which ask for JSON.
export function wantsPage(req) {
  return typeof req?.accepts === "function" && req.accepts(["json", "html"]) === "html";
}

// A page the browser opened with a link, so a reload shows it again.
export function opensAsPage(req) {
  return req?.method === "GET" && wantsPage(req);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

function plainPage(body) {
  return `<!doctype html><html lang="bg"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NovariumAI</title></head><body><main>${body}</main></body></html>`;
}

// How the page lets the person try again:
// - `retryPath`: a same-site path to open again, shown as a link;
// - `resend`: a form that was sent, `{ action, fields }`, shown as a button
//   that sends the same fields once more (the connector's consent opens in a
//   window with no Back or Reload);
// - `startOver`: the same form could never go through (its consent ran
//   out), so the page says to start over;
// - none: reload the page.
export function signInBusyPage(retryPath = "", { resend = null, startOver = false } = {}) {
  let again = "<p>Обнови тази страница след малко.</p>";
  if (retryPath) {
    again = `<p><a href="${escapeHtml(retryPath)}">Опитай пак</a></p>`;
  } else if (resend?.action) {
    const hidden = Object.entries(resend.fields || {})
      .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
      .join("");
    again = `<form method="post" action="${escapeHtml(resend.action)}">${hidden}<button type="submit">Опитай пак</button></form><p>Ако и това не мине, затвори прозореца и започни свързването отново.</p>`;
  } else if (startOver) {
    again = "<p>Затвори прозореца и започни свързването отново.</p>";
  }
  return plainPage(
    `<h1>Входът временно не е достъпен</h1><p>Входът ти е запазен. Опитай отново след малко.</p>${again}`,
  );
}

export function sendSignInBusy(res, retryPath = "", options = {}) {
  res.set("Cache-Control", "no-store");
  res.set("Retry-After", "5");
  return res.status(503).type("html").send(signInBusyPage(retryPath, options));
}

// The connector's consent window, when the consent cannot go on (it ran out,
// the person is signed out): a page with what happened and how to start over,
// not a bare JSON error in a window with no Back.
export function consentEndedPage(description) {
  return plainPage(
    `<h1>Свързването не мина</h1><p>${escapeHtml(description)}</p><p>Затвори прозореца и започни свързването отново.</p>`,
  );
}

// Too many attempts from one address, on a page the browser opened itself.
export function tooManyRequestsPage(message) {
  return plainPage(`<h1>Твърде много опити</h1><p>${escapeHtml(message)}</p>`);
}
