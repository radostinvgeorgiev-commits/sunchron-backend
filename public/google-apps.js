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

  body.addEventListener("click", async (event) => {
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
