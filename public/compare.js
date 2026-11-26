(() => {
  // Blind comparison, like LMArena: the question in the message box goes to
  // two models, the answers show as "Модел А" and "Модел Б", and the names
  // appear only after the person votes.
  const input = document.getElementById("chatInput");
  const list = document.getElementById("chatMessages");
  if (!input || !list) return;
  const text = (value) => globalThis.AiCoreLocale?.text?.(value) ?? value;
  const render = (element, value) => {
    if (globalThis.SynchronChat?.renderMarkdown) globalThis.SynchronChat.renderMarkdown(element, value);
    else element.textContent = value;
  };

  // Web search: the question in the box is answered from the internet, with
  // the sources listed under the answer.
  document.addEventListener("aicore:web-search", async () => {
    const question = input.value.trim();
    const chat = globalThis.SynchronChat;
    if (!question) {
      input.placeholder = text("Първо напиши какво да потърся, после избери „Търси в интернет“");
      input.focus();
      return;
    }
    if (!chat || chat.busy?.()) return;
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    chat.append("user", question);
    chat.setBusy(true);
    const bubble = chat.append("agent", text("🔎 Търся в интернет…"));
    try {
      const response = await fetch("/chat/search", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: question, sessionId: chat.sessionId() }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || text("Търсенето не успя. Опитай пак."));
      const sources = (data.sources || []).map(({ title, url }) => `- [${title}](${url})`);
      render(bubble, [data.text, ...(sources.length ? [`**${text("Източници")}:**`, sources.join("\n")] : [])].join("\n\n"));
    } catch (error) {
      render(bubble, `❌ ${error.message}`);
    } finally {
      chat.setBusy(false);
      list.scrollTop = list.scrollHeight;
    }
  });

  document.addEventListener("aicore:blind-compare", async () => {
    const question = input.value.trim();
    if (!question) {
      input.placeholder = text("Първо напиши въпроса, после избери „Сляпо сравнение“");
      input.focus();
      return;
    }
    if (globalThis.SynchronChat?.busy?.()) return;
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector(".quick-start, #quickStart")?.setAttribute("hidden", "");

    const box = document.createElement("section");
    box.className = "compare-box";
    box.innerHTML = `<p class="compare-question"></p><p class="compare-status" role="status"></p>`;
    box.querySelector(".compare-question").textContent = question;
    box.querySelector(".compare-status").textContent = text("Два модела отговарят…");
    list.appendChild(box);
    list.scrollTop = list.scrollHeight;

    let answers;
    try {
      const response = await fetch("/chat/compare", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: question, language: globalThis.SynchronChat?.language?.() }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || text("Сравнението не успя. Опитай пак."));
      answers = data.answers;
    } catch (error) {
      box.querySelector(".compare-status").textContent = `❌ ${error.message}`;
      return;
    }

    box.querySelector(".compare-status").textContent = text("Кой отговор е по-добър?");
    const columns = document.createElement("div");
    columns.className = "council-columns";
    answers.forEach((answer, index) => {
      const card = document.createElement("section");
      card.className = "council-card";
      const title = document.createElement("h3");
      title.textContent = `${text("Модел")} ${"АБ"[index]}`;
      const body = document.createElement("div");
      render(body, answer.text);
      card.append(title, body);
      columns.appendChild(card);
    });
    const votes = document.createElement("div");
    votes.className = "compare-votes";
    const options = [
      ["a", text("А е по-добър")],
      ["tie", text("Равни")],
      ["b", text("Б е по-добър")],
    ];
    for (const [choice, label] of options) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.addEventListener("click", () => {
        votes.remove();
        columns.querySelectorAll("h3").forEach((title, index) => {
          title.textContent = `${text("Модел")} ${"АБ"[index]} · ${answers[index].label}`;
        });
        const winner = choice === "a" ? 0 : choice === "b" ? 1 : -1;
        box.querySelector(".compare-status").textContent =
          winner < 0
            ? text("Отбелязано: равни.")
            : `${text("Избра")}: ${answers[winner].label}.`;
        void fetch("/api/feedback", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            votes: answers.map(({ provider, model }, index) => ({
              provider,
              model,
              kind: winner < 0 ? "tie" : index === winner ? "win" : "loss",
            })),
          }),
        }).catch(() => {});
      });
      votes.appendChild(button);
    }
    box.append(columns, votes);
    list.scrollTop = list.scrollHeight;
  });
})();
