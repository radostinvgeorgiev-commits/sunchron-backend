(() => {
  const messages = document.getElementById("chatMessages");
  const input = document.getElementById("chatInput");
  const starters = document.getElementById("quickStart");
  const find = document.getElementById("conversationFind");
  const query = document.getElementById("conversationQuery");
  const count = document.getElementById("conversationFindCount");
  if (!messages || !input || !starters || !find || !query || !count) return;
  let matches = [];
  let position = -1;
  const turns = () => [
    ...messages.querySelectorAll(
      ".user-turn, .assistant-turn:not(.welcome-turn)",
    ),
  ];
  function clearMatches() {
    messages
      .querySelectorAll(".conversation-match")
      .forEach((node) => node.classList.remove("conversation-match"));
  }
  function search() {
    clearMatches();
    const text = query.value.trim().toLocaleLowerCase("bg-BG");
    matches = text
      ? turns().filter((turn) =>
          (
            turn.querySelector(".message")?.dataset.rawText ||
            turn.querySelector(".message")?.textContent ||
            ""
          )
            .toLocaleLowerCase("bg-BG")
            .includes(text),
        )
      : [];
    position = -1;
    count.textContent = text
      ? `Намерени съобщения: ${matches.length}`
      : "Въведи дума или фраза.";
  }
  function next() {
    clearMatches();
    if (!matches.length) return;
    position = (position + 1) % matches.length;
    matches[position].classList.add("conversation-match");
    matches[position].scrollIntoView?.({ block: "center", behavior: "auto" });
    count.textContent = `${position + 1} от ${matches.length}`;
  }
  document
    .getElementById("conversationFindBtn")
    ?.addEventListener("click", () => {
      find.hidden = !find.hidden;
      if (!find.hidden) {
        query.focus();
        search();
      } else clearMatches();
    });
  function closeFind() {
    find.hidden = true;
    clearMatches();
    document.getElementById("conversationFindBtn")?.focus();
  }
  document
    .getElementById("conversationFindClose")
    ?.addEventListener("click", closeFind);
  document
    .getElementById("conversationFindNext")
    ?.addEventListener("click", next);
  query.addEventListener("input", search);
  find.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeFind();
    if (event.key === "Enter") {
      event.preventDefault();
      next();
    }
  });
  starters.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-starter]");
    if (!button || input.disabled) return;
    if (
      input.value.trim() &&
      !window.confirm("Да заменя ли написания текст с избраната задача?")
    )
      return;
    input.value = button.dataset.starter;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
  });
  function update() {
    if (!messages.contains(starters)) messages.appendChild(starters);
    starters.hidden = turns().length > 0 || input.disabled;
    if (!find.hidden) search();
  }
  new MutationObserver(update).observe(messages, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  new MutationObserver(update).observe(input, {
    attributes: true,
    attributeFilter: ["disabled"],
  });
  document
    .getElementById("conversationExportBtn")
    ?.addEventListener("click", () => {
      const content = turns().map((turn) => {
        const message = turn.querySelector(".message");
        const role = turn.classList.contains("user-turn") ? "Ти" : "AI CORE";
        const text = message?.dataset.rawText || message?.textContent || "";
        const image = message?.querySelector("img")
          ? "\n[Снимка — не е включена в текстовия отчет]"
          : "";
        return `## ${role}\n\n${text}${image}`;
      });
      if (!content.length) {
        window.alert("Няма съобщения за изтегляне.");
        return;
      }
      if (input.disabled) {
        window.alert(
          "Изчакай отговорът да приключи, преди да изтеглиш разговора.",
        );
        return;
      }
      if (
        !window.confirm(
          "Да изтегля ли текста на текущия разговор на това устройство? Файлът може да съдържа лични данни.",
        )
      )
        return;
      const date = new Date().toISOString().slice(0, 10);
      const blob = new Blob(
        [
          `# AI CORE · Разговор\n\nДата на износ: ${date}\n\n${content.join("\n\n")}\n`,
        ],
        { type: "text/markdown;charset=utf-8" },
      );
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `ai-core-razgovor-${date}.md`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  update();
})();
