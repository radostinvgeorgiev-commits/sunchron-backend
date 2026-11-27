(() => {
  // "+" → „Запис от среща“: pick a recording (a phone voice memo, a Zoom or
  // Meet download); NovariumAI returns a summary, decisions and tasks, keeps the
  // text in „Моите файлове“, and the tasks go to „Моите задачи“ in one press.
  const list = document.getElementById("chatMessages");
  if (!list) return;
  const text = (value) => globalThis.NovariumLocale?.text?.(value) ?? value;
  const MAX_BYTES = 30 * 1024 * 1024;
  const picker = document.createElement("input");
  picker.type = "file";
  picker.accept = "audio/*,video/mp4,video/quicktime,video/webm,.m4a,.mp3,.wav";
  picker.hidden = true;
  picker.className = "meeting-input";
  document.body.appendChild(picker);

  const render = (element, value) => {
    if (globalThis.SynchronChat?.renderMarkdown) globalThis.SynchronChat.renderMarkdown(element, value);
    else element.textContent = value;
  };

  const offerTasks = (bubble, tasks) => {
    const turn = bubble?.closest(".assistant-turn") || bubble?.parentElement;
    if (!turn || !tasks.length) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "answer-todos";
    button.innerHTML = '<i class="fa-solid fa-list-check" aria-hidden="true"></i><span></span>';
    const label = button.querySelector("span");
    label.textContent = `${text("Добави в Моите задачи")} (${tasks.length})`;
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        const response = await fetch("/api/todos", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items: tasks }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || text("Задачите не бяха записани."));
        label.textContent = text("Добавено в Моите задачи");
        button.classList.add("done");
      } catch (error) {
        label.textContent = error.message;
        button.disabled = false;
      }
    });
    const actions = turn.querySelector(".message-actions");
    turn.insertBefore(button, actions || null);
  };

  document.addEventListener("novarium:meeting", () => {
    if (globalThis.SynchronChat?.busy?.()) return;
    picker.value = "";
    picker.click();
  });

  picker.addEventListener("change", async () => {
    const file = picker.files?.[0];
    const chat = globalThis.SynchronChat;
    if (!file || !chat) return;
    chat.append("user", `🎙️ ${text("Запис от среща")}: ${file.name}`);
    if (file.size > MAX_BYTES) {
      render(chat.append("agent", ""), `❌ ${text("Записът е над 30 MB. Изпрати по-кратък запис или само звука.")}`);
      return;
    }
    chat.setBusy(true);
    const bubble = chat.append("agent", text("🎧 Слушам записа… При дълга среща това отнема около минута."));
    try {
      const response = await fetch("/chat/meeting", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": file.type || "audio/mp4",
          "X-Session-Id": chat.sessionId(),
          "X-File-Name": encodeURIComponent(file.name.slice(0, 80)),
        },
        body: file,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || text("Записът не можа да се обработи. Опитай пак."));
      const note = data.savedToFiles ? `\n\n_${text("Текстът на записа е запазен в „Моите файлове“, за да питаш аватара за срещата.")}_` : "";
      render(bubble, `${data.text}${note}`);
      offerTasks(bubble, Array.isArray(data.tasks) ? data.tasks : []);
    } catch (error) {
      render(bubble, `❌ ${error.message}`);
    } finally {
      chat.setBusy(false);
      list.scrollTop = list.scrollHeight;
    }
  });
})();
