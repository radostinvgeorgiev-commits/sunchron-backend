(() => {
  const drawer = document.getElementById("dataDrawer");
  const backdrop = document.getElementById("drawerBackdrop");
  const title = document.getElementById("dataDrawerTitle");
  const body = document.getElementById("dataDrawerBody");
  const sidebar = document.getElementById("sidebar");
  const gmailButton = document.getElementById("gmailBtn");
  const calendarButton = document.getElementById("googleCalendarBtn");
  const mapsButton = document.getElementById("googleMapsBtn");
  if (!drawer || !body || !gmailButton || !calendarButton || !mapsButton) return;

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
    if (!response.ok) throw new Error(data.error || "Google услугата временно не е достъпна.");
    return data;
  }

  function reconnect(error) {
    body.innerHTML = `
      <div class="drawer-state drawer-error">${escapeHtml(error.message)}</div>
      <button type="button" class="new-chat" id="reconnectGoogle">
        <i class="fa-brands fa-google"></i><span>Свържи Google отново</span>
      </button>`;
    document.getElementById("reconnectGoogle").addEventListener("click", () => {
      window.location.href = "/api/google/connect";
    });
  }

  async function showGmail() {
    openDrawer("Gmail");
    body.innerHTML = '<div class="drawer-state"><i class="fa-solid fa-circle-notch fa-spin"></i> Зареждане…</div>';
    try {
      const data = await request("/api/google/gmail/messages?limit=15");
      const messages = Array.isArray(data.messages) ? data.messages : [];
      body.innerHTML = `
        <section class="drawer-section">
          <div class="permission-default">Последни имейли — само за четене. AI CORE не може да изпраща или изтрива.</div>
          ${messages.length ? messages.map((message) => `
            <article class="permission-card">
              <div>
                <strong>${message.unread ? "● " : ""}${escapeHtml(message.subject)}</strong>
                <p>${escapeHtml(message.from)}</p>
                <p>${escapeHtml(message.snippet)}</p>
              </div>
              <a href="${escapeHtml(message.url)}" target="_blank" rel="noopener noreferrer">Отвори</a>
            </article>`).join("") : '<div class="drawer-empty">Няма намерени имейли.</div>'}
        </section>`;
    } catch (error) {
      reconnect(error);
    }
  }

  async function showCalendar() {
    openDrawer("Google Calendar");
    body.innerHTML = '<div class="drawer-state"><i class="fa-solid fa-circle-notch fa-spin"></i> Зареждане…</div>';
    try {
      const data = await request("/api/google/calendar/events?days=14&limit=25");
      const events = Array.isArray(data.events) ? data.events : [];
      body.innerHTML = `
        <section class="drawer-section">
          <div class="permission-default">Предстоящи събития за 14 дни — само за четене.</div>
          ${events.length ? events.map((event) => `
            <article class="permission-card">
              <div>
                <strong>${escapeHtml(event.title)}</strong>
                <p>${event.start ? new Date(event.start).toLocaleString("bg-BG") : ""}</p>
                ${event.location ? `<p>${escapeHtml(event.location)}</p>` : ""}
              </div>
              ${event.url ? `<a href="${escapeHtml(event.url)}" target="_blank" rel="noopener noreferrer">Отвори</a>` : ""}
            </article>`).join("") : '<div class="drawer-empty">Няма предстоящи събития.</div>'}
        </section>`;
    } catch (error) {
      reconnect(error);
    }
  }

  function showMaps() {
    openDrawer("Google Maps");
    body.innerHTML = `
      <section class="drawer-section">
        <div class="permission-default">Потърси място, хотел, заведение или маршрут. Резултатът се отваря в Google Maps.</div>
        <div class="chat-input-area">
          <input id="mapsQuery" type="search" placeholder="Например: хотел в Търново">
          <button id="mapsSearch" type="button" aria-label="Търси"><i class="fa-solid fa-magnifying-glass"></i></button>
        </div>
      </section>`;
    const input = document.getElementById("mapsQuery");
    const search = () => {
      const query = input.value.trim();
      if (query) window.open(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`, "_blank", "noopener,noreferrer");
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
