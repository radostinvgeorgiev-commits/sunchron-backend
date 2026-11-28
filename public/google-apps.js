(() => {
  const drawer = document.getElementById("dataDrawer");
  const backdrop = document.getElementById("drawerBackdrop");
  const title = document.getElementById("dataDrawerTitle");
  const body = document.getElementById("dataDrawerBody");
  const sidebar = document.getElementById("sidebar");
  const gmailButton = document.getElementById("gmailBtn");
  const calendarButton = document.getElementById("googleCalendarBtn");
  const mapsButton = document.getElementById("googleMapsBtn");
  if (!drawer || !body || !gmailButton || !calendarButton || !mapsButton)
    return;

  const text = (value) => globalThis.NovariumLocale?.text?.(value) ?? value;
  const escapeHtml = (value) => {
    const div = document.createElement("div");
    div.textContent = String(value ?? "");
    return div.innerHTML;
  };

  function openDrawer(name) {
    title.textContent = name;
    drawer.hidden = false;
    backdrop.hidden = false;
    sidebar.classList.remove("mobile-visible");
  }

  async function request(path) {
    const response = await fetch(path, { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(data.error || text("Google услугата временно не е достъпна."));
    return data;
  }

  async function reconnect(error, add = "") {
    const status = await request("/api/google/status").catch(() => ({}));
    body.innerHTML = `
      <div class="drawer-state drawer-error">${escapeHtml(error.message)}</div>
      <button type="button" class="new-chat" id="reconnectGoogle">
        <i class="fa-brands fa-google"></i><span>${text("Свържи Google отново")}</span>
      </button>`;
    if (status.canRestore) body.insertAdjacentHTML(
      "beforeend",
      `
      <button type="button" class="new-chat" id="restoreGoogle">
        <i class="fa-solid fa-clock-rotate-left"></i><span>${text("Възстанови старата Google връзка")}</span>
      </button>`,
    );
    document.getElementById("reconnectGoogle").addEventListener("click", () => {
      // Not connected yet: the main connect, with the scopes Google's free
      // check covers. Connected: add=<service> asks again for everything the
      // connection has and turns on the service the person opened.
      window.location.href = add && status.connected
        ? `/api/google/connect?add=${encodeURIComponent(add)}`
        : "/api/google/connect";
    });
    document.getElementById("restoreGoogle")?.addEventListener("click", () => {
      window.location.href = "/api/google/restore";
    });
  }

  async function showGmail() {
    openDrawer("Gmail");
    body.innerHTML =
      `<div class="drawer-state"><i class="fa-solid fa-circle-notch fa-spin"></i> ${text("Зареждане…")}</div>`;
    try {
      const data = await request("/api/google/gmail/messages?limit=15");
      const messages = Array.isArray(data.messages) ? data.messages : [];
      body.innerHTML = `
        <section class="drawer-section">
          <div class="permission-default">${text("Последни имейли. „Чернова от мое име“ записва отговор в твоя стил като чернова в Gmail; нищо не се изпраща без теб.")}</div>
          <div class="permission-default">${text("„В кошчето“ мести писмото в кошчето на Gmail след второ натискане. Там стои 30 дни.")}</div>
          ${
            messages.length
              ? messages
                  .map(
                    (message) => `
            <article class="permission-card">
              <div>
                <strong>${message.unread ? "● " : ""}${escapeHtml(message.subject)}</strong>
                <p>${escapeHtml(message.from)}</p>
                <p>${escapeHtml(message.snippet)}</p>
              </div>
              <a href="${escapeHtml(message.url)}" target="_blank" rel="noopener noreferrer">${text("Отвори")}</a>
              <button type="button" class="reply-draft" data-message-id="${escapeHtml(message.id)}">${text("Чернова от мое име")}</button>
              <button type="button" class="gmail-trash" data-message-id="${escapeHtml(message.id)}">${text("В кошчето")}</button>
            </article>`,
                  )
                  .join("")
              : `<div class="drawer-empty">${text("Няма намерени имейли.")}</div>`
          }
        </section>`;
    } catch (error) {
      reconnect(error, "gmail");
    }
  }

  // „В кошчето“: the first press asks, the second moves this one letter to
  // the person's own Gmail bin (deleting keeps a confirmation). A double click
  // or a held key is one press: the second press counts only after the
  // question has been on screen for a moment.
  const trashResets = new WeakMap();
  function disarm(button) {
    clearTimeout(trashResets.get(button));
    trashResets.delete(button);
    delete button.dataset.armed;
    delete button.dataset.armedAt;
    button.classList.remove("armed");
    button.textContent = text("В кошчето");
  }

  async function trashLetter(button, event) {
    const card = button.closest("article");
    if (button.dataset.armed !== "1") {
      button.dataset.armed = "1";
      button.dataset.armedAt = String(Date.now());
      button.classList.add("armed");
      button.textContent = text("Да, в кошчето");
      clearTimeout(trashResets.get(button));
      trashResets.set(
        button,
        setTimeout(() => {
          if (!button.isConnected || button.disabled) return;
          disarm(button);
        }, 6000),
      );
      return;
    }
    if (event?.detail > 1 || Date.now() - Number(button.dataset.armedAt || 0) < 700) return;
    clearTimeout(trashResets.get(button));
    button.disabled = true;
    button.textContent = text("Местя писмото…");
    card.querySelector(".gmail-trash-error")?.remove();
    try {
      const response = await fetch("/api/google/gmail/trash", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId: button.dataset.messageId }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.trashed) {
        const failure = new Error(data.error || text("Писмото не беше преместено."));
        failure.connect = typeof data.connect === "string" ? data.connect : "";
        throw failure;
      }
      const note = document.createElement("p");
      note.className = "reply-draft-result";
      note.setAttribute("role", "status");
      note.textContent = text("Писмото е в кошчето на Gmail. Там стои 30 дни.");
      card.querySelectorAll("button").forEach((item) => item.remove());
      card.append(note);
    } catch (error) {
      button.disabled = false;
      disarm(button);
      const note = document.createElement("p");
      note.className = "drawer-error gmail-trash-error";
      // A link in the message („[Разреши Gmail](…)“) shows as its words.
      note.textContent = text(String(error.message || "")).replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1");
      if (error.connect?.startsWith("/api/google/connect")) {
        const allow = document.createElement("a");
        allow.href = error.connect;
        allow.textContent = text("Разреши Gmail");
        note.append(" ", allow);
      }
      card.append(note);
    }
  }

  body.addEventListener("click", async (event) => {
    const trash = event.target.closest(".gmail-trash");
    if (trash) {
      await trashLetter(trash, event);
      return;
    }
    const button = event.target.closest(".reply-draft");
    if (!button) return;
    const card = button.closest("article");
    button.disabled = true;
    button.textContent = text("Пиша черновата…");
    try {
      const response = await fetch("/api/google/gmail/reply-draft", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId: button.dataset.messageId }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || text("Черновата не беше записана."));
      const result = document.createElement("div");
      result.className = "reply-draft-result";
      const preview = document.createElement("p");
      preview.textContent = data.body;
      const link = document.createElement("a");
      link.href = data.draft.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = text("Отвори черновата в Gmail — прегледай и изпрати сам");
      result.append(preview, link);
      card.append(result);
      button.remove();
    } catch (error) {
      button.disabled = false;
      button.textContent = text("Чернова от мое име");
      const note = document.createElement("p");
      note.className = "drawer-error";
      note.textContent = error.message;
      card.append(note);
    }
  });

  async function showCalendar() {
    openDrawer("Google Calendar");
    body.innerHTML =
      `<div class="drawer-state"><i class="fa-solid fa-circle-notch fa-spin"></i> ${text("Зареждане…")}</div>`;
    try {
      const data = await request(
        "/api/google/calendar/events?days=14&limit=25",
      );
      const events = Array.isArray(data.events) ? data.events : [];
      body.innerHTML = `
        <section class="drawer-section">
          <div class="permission-default">${text("Предстоящи събития за 14 дни.")}</div>
          ${
            events.length
              ? events
                  .map(
                    (event) => `
            <article class="permission-card">
              <div>
                <strong>${escapeHtml(event.title)}</strong>
                <p>${event.start ? new Date(event.start).toLocaleString(globalThis.NovariumLocale?.browserLocale || "bg-BG") : ""}</p>
                ${event.location ? `<p>${escapeHtml(event.location)}</p>` : ""}
              </div>
              ${event.url ? `<a href="${escapeHtml(event.url)}" target="_blank" rel="noopener noreferrer">${text("Отвори")}</a>` : ""}
            </article>`,
                  )
                  .join("")
              : `<div class="drawer-empty">${text("Няма предстоящи събития.")}</div>`
          }
        </section>`;
    } catch (error) {
      reconnect(error);
    }
  }

  function showMaps() {
    openDrawer("Google Maps");
    body.innerHTML = `
      <section class="drawer-section">
        <div class="permission-default">${text("Потърси място, хотел, заведение или маршрут. Резултатът се отваря в Google Maps.")}</div>
        <div class="chat-input-area">
          <input id="mapsQuery" type="search" placeholder="${text("Например: хотел в Търново")}">
          <button id="mapsSearch" type="button" aria-label="${text("Търси")}"><i class="fa-solid fa-magnifying-glass"></i></button>
        </div>
      </section>`;
    const input = document.getElementById("mapsQuery");
    const search = () => {
      const query = input.value.trim();
      if (query)
        window.open(
          `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`,
          "_blank",
          "noopener,noreferrer",
        );
    };
    document.getElementById("mapsSearch").addEventListener("click", search);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") search();
    });
    input.focus();
  }

  gmailButton.addEventListener("click", showGmail);
  calendarButton.addEventListener("click", showCalendar);
  mapsButton.addEventListener("click", showMaps);
})();
