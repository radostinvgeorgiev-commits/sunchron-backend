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
  // Translation runs first, so the first answer is shown in the page language.
  const start = () => showAnswer(0);
  if (window.NovariumLocale?.ready)
    window.NovariumLocale.ready.then(start, start);
  else start();
})();
