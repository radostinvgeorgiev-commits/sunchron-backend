(() => {
  // "Моят ден": the avatar prepares today's plan from the person's profile,
  // calendar and mail. Anything already typed in the box is passed as a note.
  const input = document.getElementById("chatInput");
  const list = document.getElementById("chatMessages");
  if (!input || !list) return;
  const text = (value) => globalThis.NovariumLocale?.text?.(value) ?? value;
  const render = (element, value) => {
    if (globalThis.SynchronChat?.renderMarkdown) globalThis.SynchronChat.renderMarkdown(element, value);
    else element.textContent = value;
  };

  // "Всяка сутрин": a per-device choice; the first visit of the day then
  // prepares the plan without a click.
  const KEY = "novarium-morning-plan";
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
      key: "novarium-weekly-plan",
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
  document.addEventListener("novarium:draw-image", async () => {
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
      save.download = "novarium-kartinka.webp";
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

  // "Качи в YouTube": sends the finished clip to the person's own channel.
  // The first time Google asks for a small permission (a link is shown).
  const youtubeButton = (blob, prompt) => {
    const wrap = document.createElement("span");
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.action = "video-youtube";
    button.textContent = text("Качи в YouTube");
    const note = document.createElement("span");
    note.className = "video-note";
    note.setAttribute("role", "status");
    const say = (message, href, label) => {
      note.replaceChildren(document.createTextNode(`${message} `));
      if (href) {
        const link = document.createElement("a");
        link.href = href;
        link.textContent = label;
        if (/^https:/u.test(href)) {
          link.target = "_blank";
          link.rel = "noopener";
        }
        note.append(link);
      }
    };
    button.addEventListener("click", async () => {
      button.disabled = true;
      say(text("Качвам в YouTube…"));
      try {
        const title = prompt.replace(/\s+/gu, " ").trim().slice(0, 90);
        const response = await fetch(`/api/google/youtube?title=${encodeURIComponent(title)}`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "video/mp4" },
          body: blob,
        });
        const data = await response.json().catch(() => ({}));
        if (response.ok && data.url) {
          if (data.privacy === "public") say(text("Качено в YouTube."), data.url, text("Отвори"));
          else say(text("Качено в YouTube, засега скрито (YouTube още проверява NovariumAI). Можеш да го направиш публично от YouTube Studio."), data.studio || data.url, text("Отвори"));
          return;
        }
        if (typeof data.connect === "string" && data.connect.startsWith("/api/google/connect")) {
          say(text(data.code === "GOOGLE_SCOPE_REQUIRED" ? "Качването в YouTube иска еднократно разрешение. После пак натисни „Качи в YouTube“." : "Google не е свързан."), data.connect, text(data.code === "GOOGLE_SCOPE_REQUIRED" ? "Разреши" : "Свържи Google"));
          return;
        }
        say(data.error || text("YouTube не прие видеото. Опитай пак."));
      } catch {
        say(text("Няма връзка. Опитай пак."));
      } finally {
        button.disabled = false;
      }
    });
    wrap.append(button, note);
    return wrap;
  };

  // "Направи видео": the description in the box becomes a short clip with
  // sound (an ad or anything else). The server sends the MP4 file itself.
  document.addEventListener("novarium:make-video", async () => {
    const chat = globalThis.SynchronChat;
    const prompt = input.value.trim();
    if (!prompt) {
      input.placeholder = text("Първо опиши видеото (напр. реклама за кафене, за телефон), после избери „Направи видео“");
      input.focus();
      return;
    }
    if (!chat || chat.busy?.()) return;
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    chat.append("user", `🎬 ${prompt}`);
    chat.setBusy(true);
    const bubble = chat.append("agent", text("🎬 Правя видеото… това отнема от една до четири минути. Не затваряй страницата."));
    try {
      const response = await fetch("/api/videos", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || text("Видеото не стана. Опитай пак."));
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const figure = document.createElement("figure");
      figure.className = "generated-video";
      const video = document.createElement("video");
      video.src = url;
      video.controls = true;
      video.playsInline = true;
      video.setAttribute("aria-label", prompt);
      const save = document.createElement("a");
      save.href = url;
      save.download = "novarium-video.mp4";
      save.textContent = text("Изтегли видеото");
      const actions = document.createElement("div");
      actions.className = "video-actions";
      actions.append(save, youtubeButton(blob, prompt));
      figure.append(video, actions);
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
  document.addEventListener("novarium:daily-plan", () => preparePlan("day"));
  document.addEventListener("novarium:weekly-plan", () => preparePlan("week"));

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
