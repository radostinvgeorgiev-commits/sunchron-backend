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
  // The Monday that starts this week, in Sofia time: one weekly review per week.
  const thisWeek = () => {
    const day = new Date(`${today()}T12:00:00Z`);
    day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
    return day.toISOString().slice(0, 10);
  };
  // "Моят ден" comes by itself each morning, "Моята седмица" each Monday
  // (or the first visit of the week), when the person turns it on.
  const PLANS = {
    day: {
      key: KEY,
      stamp: today,
      title: "Моят ден",
      waiting: "☀️ Подготвям плана ти за днес…",
      on: "✓ Идва сам всяка сутрин · изключи",
      off: "Показвай ми плана сам всяка сутрин",
    },
    week: {
      key: "aicore-weekly-plan",
      stamp: thisWeek,
      title: "Моята седмица",
      waiting: "🗓️ Подготвям прегледа на седмицата…",
      on: "✓ Идва сам всеки понеделник · изключи",
      off: "Показвай ми седмицата сама всеки понеделник",
    },
  };
  const autoToggle = (period) => {
    const plan = PLANS[period];
    const on = store.get(plan.key) === "on";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "morning-toggle";
    button.dataset.period = period;
    button.setAttribute("aria-pressed", String(on));
    button.textContent = text(on ? plan.on : plan.off);
    button.addEventListener("click", () => {
      const next = store.get(plan.key) === "on" ? "off" : "on";
      store.set(plan.key, next);
      if (next === "on") store.set(`${plan.key}-day`, plan.stamp());
      button.replaceWith(autoToggle(period));
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

  const preparePlan = async (period) => {
    const plan = PLANS[period];
    const chat = globalThis.SynchronChat;
    if (!chat || chat.busy?.()) return;
    const note = input.value.trim();
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    chat.append("user", note ? `${text(plan.title)}: ${note}` : text(plan.title));
    chat.setBusy(true);
    const bubble = chat.append("agent", text(plan.waiting));
    try {
      const response = await fetch("/api/daily-plan", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note, period }),
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
      bubble.append(autoToggle(period));
    } catch (error) {
      render(bubble, `❌ ${error.message}`);
    } finally {
      chat.setBusy(false);
      list.scrollTop = list.scrollHeight;
    }
  };
  document.addEventListener("aicore:daily-plan", () => preparePlan("day"));
  document.addEventListener("aicore:weekly-plan", () => preparePlan("week"));

  // Wait until the person is signed in and the chat is ready. The weekly
  // review goes first; the day plan follows once the chat is free again.
  const due = () =>
    ["week", "day"].filter((period) => {
      const plan = PLANS[period];
      return store.get(plan.key) === "on" && store.get(`${plan.key}-day`) !== plan.stamp();
    });
  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    const chat = globalThis.SynchronChat;
    const ready = document.body.dataset.userRole && chat?.append;
    if (!ready && tries < 40) return;
    if (!ready || !due().length) {
      clearInterval(timer);
      return;
    }
    if (chat.busy?.()) {
      if (tries > 400) clearInterval(timer);
      return;
    }
    const period = due()[0];
    store.set(`${PLANS[period].key}-day`, PLANS[period].stamp());
    void preparePlan(period);
  }, 500);
})();
