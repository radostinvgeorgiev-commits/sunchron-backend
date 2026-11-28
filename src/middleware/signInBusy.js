// A passing fault while the sign-in is renewed (no answer from Google, too
// many requests, a fault at Google): resolveUserSession keeps the sign-in and
// throws a UserAuthError 503 AUTH_UNAVAILABLE. A page opened in the browser
// (a connect link, the return from Google or GitHub, the connector's consent)
// then says to try again in a moment, never a bare JSON error (RADKO 28.11:
// Safari saved one as connect.json).
export function isPassingSignInFault(error) {
  return error?.code === "AUTH_UNAVAILABLE" && Number(error?.status) === 503;
}

// `retryPath` is a path the caller has already checked (same site, fixed
// form). Without it the page says to reload, or, after a pressed button
// (`formSent`), to go back and press it again, since a reload would send the
// form a second time.
export function signInBusyPage(retryPath = "", { formSent = false } = {}) {
  const again = retryPath
    ? `<p><a href="${retryPath}">Опитай пак</a></p>`
    : formSent
      ? "<p>Върни се назад и натисни бутона отново.</p>"
      : "<p>Обнови тази страница след малко.</p>";
  return `<!doctype html><html lang="bg"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NovariumAI</title></head><body><main><h1>Входът временно не е достъпен</h1><p>Входът ти е запазен. Опитай отново след малко.</p>${again}</main></body></html>`;
}

export function sendSignInBusy(res, retryPath = "", options = {}) {
  res.set("Cache-Control", "no-store");
  res.set("Retry-After", "5");
  return res.status(503).type("html").send(signInBusyPage(retryPath, options));
}
