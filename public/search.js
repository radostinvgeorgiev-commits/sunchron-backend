(() => {
  const composer = document.querySelector(".composer-wrap");
  const input = document.getElementById("chatInput");
  if (!composer || !input) return;

  const bar = document.createElement("div");
  bar.className = "search-mode-bar";
  bar.setAttribute("aria-label", "Режим на работа");
  bar.innerHTML = [
    '<button type="button" class="search-mode active" data-mode="chat"><i class="fa-regular fa-message"></i> Разговор</button>',
    '<button type="button" class="search-mode" data-mode="ai"><i class="fa-solid fa-wand-magic-sparkles"></i> AI търсене</button>',
    '<button type="button" class="search-mode" data-mode="google"><i class="fa-brands fa-google"></i> Google</button>',
  ].join("");
  composer.prepend(bar);

  let mode = "chat";
  const buttons = [...bar.querySelectorAll(".search-mode")];

  function selectMode(nextMode) {
    mode = nextMode;
    buttons.forEach((button) => button.classList.toggle("active", button.dataset.mode === mode));
    input.placeholder = mode === "chat"
      ? "Попитай нещо"
      : mode === "ai"
        ? "Потърси с AI в интернет"
        : "Потърси в Google";
    input.focus();
  }

  buttons.forEach((button) => {
    button.addEventListener("click", () => selectMode(button.dataset.mode));
  });

  async function runSearch() {
    const query = input.value.trim();
    if (!query) {
      input.focus();
      return;
    }

    if (mode === "google") {
      window.open("https://www.google.com/search?q=" + encodeURIComponent(query), "_blank", "noopener,noreferrer");
      return;
    }

    if (state.chatBusy) return;
    state.chatBusy = true;
    elements.sendBtn.disabled = true;
    input.disabled = true;
    appendMessage("user", query);
    input.value = "";
    const pending = appendMessage("agent", "Търся в интернет…");

    try {
      const response = await fetch("/search/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Търсенето не успя.");

      let answer = data.text;
      if (Array.isArray(data.sources) && data.sources.length) {
        answer += "\n\n**Източници:**\n" + data.sources
          .map((source) => "- [" + source.title.replace(/[\[\]]/g, "") + "](" + source.url + ")")
          .join("\n");
      }
      renderAgentText(pending, answer);
      logAction("AI търсене в интернет");
    } catch (error) {
      renderAgentText(pending, "❌ " + error.message);
    } finally {
      state.chatBusy = false;
      elements.sendBtn.disabled = false;
      input.disabled = false;
      input.focus();
    }
  }

  elements.sendBtn.addEventListener("click", (event) => {
    if (mode === "chat") return;
    event.stopImmediatePropagation();
    runSearch();
  }, true);

  input.addEventListener("keydown", (event) => {
    if (mode === "chat" || event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    runSearch();
  }, true);

  selectMode("chat");
})();
