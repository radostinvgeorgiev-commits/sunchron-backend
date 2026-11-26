(() => {
  // "Моят ден": the avatar prepares today's plan from the person's profile,
  // calendar and mail. Anything already typed in the box is passed as a note.
  const input = document.getElementById("chatInput");
  const list = document.getElementById("chatMessages");
  if (!input || !list) return;
  const text = (value) => globalThis.AiCoreLocale?.text?.(value) ?? value;
  const render = (element, value) => {
    if (globalThis.SynchronChat?.renderMarkdown) globalThis.SynchronChat.renderMarkdown(element, value);
    else element.textContent = value;
  };

  // "Всяка сутрин": a per-device choice; the first visit of the day then
  // prepares the plan without a click.
  const KEY = "aicore-morning-plan";
  const store = {
    get: (name) => {
      try {
        return globalThis.localStorage?.getItem(name) || "";
      } catch {
        return "";
      }
    },
    set: (name, value) => {
      try {
        globalThis.localStorage?.setItem(name, value);
      } catch {
        // Storage can be unavailable; the button then simply does nothing lasting.
      }
    },
  };
  const today = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Sofia" });
  const morningToggle = () => {
    const on = store.get(KEY) === "on";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "morning-toggle";
    button.setAttribute("aria-pressed", String(on));
    button.textContent = on
      ? text("✓ Идва сам всяка сутрин · изключи")
      : text("Показвай ми плана сам всяка сутрин");
    button.addEventListener("click", () => {
      const next = store.get(KEY) === "on" ? "off" : "on";
      store.set(KEY, next);
      if (next === "on") store.set(`${KEY}-day`, today());
      button.replaceWith(morningToggle());
    });
    return button;
  };

  // "Нарисувай картинка": the description in the box becomes a picture.
  document.addEventListener("aicore:draw-image", async () => {
    const chat = globalThis.SynchronChat;
    const prompt = input.value.trim();
    if (!prompt) {
      input.placeholder = text("Първо опиши картинката, после избери „Нарисувай картинка“");
      input.focus();
      return;
    }
    if (!chat || chat.busy?.()) return;
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    chat.append("user", `🎨 ${prompt}`);
    chat.setBusy(true);
    const bubble = chat.append("agent", text("🎨 Рисувам… това отнема до половин минута."));
    try {
      const response = await fetch("/api/images", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || text("Картинката не стана. Опитай пак."));
      const figure = document.createElement("figure");
      figure.className = "generated-image";
      const image = document.createElement("img");
      image.src = data.image;
      image.alt = prompt;
      const save = document.createElement("a");
      save.href = data.image;
      save.download = "aicore-kartinka.webp";
      save.textContent = text("Изтегли картинката");
      figure.append(image, save);
      bubble.replaceChildren(figure);
    } catch (error) {
      render(bubble, `❌ ${error.message}`);
    } finally {
      chat.setBusy(false);
      list.scrollTop = list.scrollHeight;
    }
  });

  document.addEventListener("aicore:daily-plan", async () => {
    const chat = globalThis.SynchronChat;
    if (!chat || chat.busy?.()) return;
    const note = input.value.trim();
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    chat.append("user", note ? `${text("Моят ден")}: ${note}` : text("Моят ден"));
    chat.setBusy(true);
    const bubble = chat.append("agent", text("☀️ Подготвям плана ти за днес…"));
    try {
      const response = await fetch("/api/daily-plan", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || text("Планът не можа да се подготви. Опитай пак."));
      const missing = [
        data.sources?.profile ? "" : text("попълни „Моят аватар“"),
        data.sources?.calendar === null ? text("свържи „Моят Google“ за календар и поща") : "",
      ].filter(Boolean);
      render(
        bubble,
        [data.text, missing.length ? `_${text("За по-точен план")}: ${missing.join("; ")}._` : ""]
          .filter(Boolean)
          .join("\n\n"),
      );
      bubble.append(morningToggle());
    } catch (error) {
      render(bubble, `❌ ${error.message}`);
    } finally {
      chat.setBusy(false);
      list.scrollTop = list.scrollHeight;
    }
  });

  // Wait until the person is signed in and the chat is ready, then run once a day.
  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    const ready = document.body.dataset.userRole && globalThis.SynchronChat?.append;
    if (!ready && tries < 40) return;
    clearInterval(timer);
    if (!ready || store.get(KEY) !== "on" || store.get(`${KEY}-day`) === today()) return;
    store.set(`${KEY}-day`, today());
    document.dispatchEvent(new CustomEvent("aicore:daily-plan"));
  }, 500);
})();
