// The public start page: the sign-in card opens in a window over the page,
// and the small "how it remembers" demo answers without any AI request.
(() => {
  const gate = document.getElementById("authGate");
  const dialog = document.getElementById("authDialog");
  if (!gate || !dialog) return;

  const supportsModal = typeof dialog.showModal === "function";

  function openAuth() {
    if (gate.hidden || dialog.open) return;
    if (supportsModal) dialog.showModal();
    else dialog.setAttribute("open", "");
    dialog.querySelector(".auth-google:not([hidden]), #loginEmail")?.focus();
  }

  function closeAuth() {
    if (!dialog.open) return;
    if (supportsModal) dialog.close();
    else dialog.removeAttribute("open");
  }

  for (const button of document.querySelectorAll("[data-open-auth]")) {
    button.addEventListener("click", openAuth);
  }
  dialog
    .querySelector("[data-close-auth]")
    ?.addEventListener("click", closeAuth);
  // A click on the dark area around the card closes it.
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) closeAuth();
  });

  // Signed in: the private app replaces the page, so the window goes too.
  new MutationObserver(() => {
    if (gate.hidden) closeAuth();
  }).observe(gate, { attributes: true, attributeFilter: ["hidden"] });

  // A sign-in message (for example a failed Google sign-in) must be seen.
  const message = document.getElementById("authMessage");
  if (message) {
    new MutationObserver(() => {
      if (message.textContent.trim()) openAuth();
    }).observe(message, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  }

  // Old /register links and ?signin=1 open the sign-in window straight away.
  const params = new URLSearchParams(window.location.search);
  const wantsSignIn =
    window.location.pathname === "/register" ||
    params.has("signin") ||
    params.has("auth_error") ||
    params.has("google_error");
  if (wantsSignIn) {
    const whenShown = () => {
      if (!gate.hidden) openAuth();
    };
    setTimeout(whenShown, 400);
    setTimeout(whenShown, 1500);
  }

  // Side panels open from their links (#how, #prices…). A click outside the
  // open panel or Escape closes it.
  const closePanel = () => {
    if (!document.querySelector(".landing-panels .landing-section.is-open")) return;
    history.pushState("", document.title, window.location.pathname + window.location.search);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    document.querySelectorAll(".landing-panels .landing-section").forEach((panel) => panel.classList.remove("is-open"));
  };
  const syncPanel = () => {
    const id = decodeURIComponent(window.location.hash.slice(1));
    document.querySelectorAll(".landing-panels .landing-section").forEach((panel) => panel.classList.toggle("is-open", Boolean(id) && panel.id === id));
  };
  window.addEventListener("hashchange", syncPanel);
  syncPanel();
  document.addEventListener("click", (event) => {
    const open = document.querySelector(".landing-panels .landing-section.is-open");
    if (!open || dialog.open || open.contains(event.target) || event.target.closest("a[href^='#'], [data-open-auth]")) return;
    closePanel();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !dialog.open) closePanel();
  });

  // The demo: three requests, three answers from the approved memory.
  const options = [...document.querySelectorAll("[data-demo]")];
  const answers = [...document.querySelectorAll("[data-demo-answer]")];
  const output = document.querySelector("[data-demo-output]");
  function showAnswer(index) {
    const answer = answers[index];
    if (!answer || !output) return;
    options.forEach((option, position) => {
      option.setAttribute("aria-checked", String(position === index));
    });
    output.replaceChildren(answer.cloneNode(true));
    output.firstElementChild.removeAttribute("data-demo-answer");
    output.classList.remove("landing-demo-fresh");
    void output.offsetWidth;
    output.classList.add("landing-demo-fresh");
  }
  options.forEach((option, index) => {
    option.addEventListener("click", () => showAnswer(index));
    option.addEventListener("keydown", (event) => {
      if (
        !["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"].includes(event.key)
      )
        return;
      event.preventDefault();
      const step =
        event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1;
      const next = (index + step + options.length) % options.length;
      options[next].focus();
      showAnswer(next);
    });
  });
  // The free chapter check: no sign-in, nothing saved; the answer shows each
  // clash as the fact and the chapter's own words side by side.
  const freeForm = document.querySelector("[data-free-check]");
  const freeResult = document.querySelector("[data-free-result]");
  const say = (value) => window.NovariumLocale?.text?.(value) ?? value;
  if (freeForm && freeResult) {
    const status = freeForm.querySelector(".landing-free-status");
    const button = freeForm.querySelector("button[type=submit]");
    freeForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const data = new FormData(freeForm);
      button.disabled = true;
      status.textContent = say("Проверявам главата…");
      freeResult.hidden = true;
      try {
        const response = await fetch("/api/free-check", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ facts: data.get("facts"), text: data.get("text") }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || say("Нещо се обърка. Опитай отново."));
        const { score, issues = [], models } = body.result || {};
        freeResult.querySelector(".landing-free-score").textContent = `${say("Съвпадение с паметта")}: ${score}/100 · ${
          issues.length ? `${say("противоречия")}: ${issues.length}` : say("няма противоречия")
        } · ${models === 2 ? say("проверено от два модела") : say("проверено от един модел")}`;
        freeResult.querySelector(".landing-free-issues").replaceChildren(
          ...issues.map((issue) => {
            const row = document.createElement("li");
            const fact = document.createElement("p");
            const factLabel = document.createElement("strong");
            factLabel.textContent = `${say("В книгата")}: `;
            fact.append(factLabel, document.createTextNode(issue.fact));
            const quote = document.createElement("p");
            const quoteLabel = document.createElement("strong");
            quoteLabel.textContent = `${say("Главата")}: `;
            quote.append(quoteLabel, document.createTextNode(`„${issue.quote}“`));
            row.append(fact, quote);
            if (issue.why) {
              const why = document.createElement("small");
              why.textContent = issue.why;
              row.append(why);
            }
            return row;
          }),
        );
        freeResult.hidden = false;
        status.textContent = "";
      } catch (error) {
        status.textContent = error.message;
      } finally {
        button.disabled = false;
      }
    });
  }

  // Translation runs first, so the first answer is shown in the page language.
  const start = () => showAnswer(0);
  if (window.NovariumLocale?.ready)
    window.NovariumLocale.ready.then(start, start);
  else start();
})();
