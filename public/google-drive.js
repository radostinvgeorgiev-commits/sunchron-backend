(() => {
  const button = document.getElementById("googleDriveBtn");
  const drawer = document.getElementById("dataDrawer");
  const drawerBackdrop = document.getElementById("drawerBackdrop");
  const title = document.getElementById("dataDrawerTitle");
  const body = document.getElementById("dataDrawerBody");
  const sidebar = document.getElementById("sidebar");
  let lastAnalysis = "";

  if (!button || !drawer || !body) return;
  const text = (value) => globalThis.NovariumLocale?.text?.(value) ?? value;

  // The stored Google sign-in no longer works: "Свържи Google отново".
  const RECONNECT_CODES = new Set([
    "NOT_CONNECTED",
    "TOKEN_EXPIRED",
    "REFRESH_FAILED",
    "GOOGLE_RECONNECT_REQUIRED",
  ]);
  // Server messages may carry a chat-style [text](link); the drawer shows its
  // own button instead.
  const plainMessage = (value) =>
    String(value ?? "").replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1");

  const escapeHtml = (value) => {
    const div = document.createElement("div");
    div.textContent = String(value ?? "");
    return div.innerHTML;
  };

  function openDrawer() {
    title.textContent = text("Моят Google");
    drawer.hidden = false;
    drawerBackdrop.hidden = false;
    sidebar.classList.remove("mobile-visible");
  }

  async function request(path, options) {
    const response = await fetch(path, { cache: "no-store", ...options });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || text("Google временно не е достъпен."));
      error.code = data.code || "";
      throw error;
    }
    return data;
  }

  async function renderDrive() {
    openDrawer();
    body.innerHTML =
      `<div class="drawer-state"><i class="fa-solid fa-circle-notch fa-spin"></i> ${text("Зареждане…")}</div>`;
    let connected = false;
    try {
      const status = await request("/api/google/status");
      connected = Boolean(status.connected);
      if (!status.connected) {
        body.innerHTML = `
          <section class="drawer-section">
            <div class="permission-default">${text("Свържи своя Google профил. NovariumAI ще вижда календара и контактите ти, а събития, контакти и имейли ще създава само след твоето „Потвърди“. Файловете ти в Drive не вижда, освен тези, които сам запазиш от NovariumAI.")}</div>
            <button type="button" class="new-chat" id="connectGoogleDrive">
              <i class="fa-brands fa-google"></i><span>${text("Свържи Google")}</span>
            </button>
            ${
              status.canRestore
                ? `<button type="button" class="new-chat" id="restoreGoogleDrive">
              <i class="fa-solid fa-clock-rotate-left"></i><span>${text("Възстанови старата Google връзка")}</span>
            </button>`
                : ""
            }
          </section>`;
        document
          .getElementById("connectGoogleDrive")
          .addEventListener("click", () => {
            window.location.href = "/api/google/connect";
          });
        document
          .getElementById("restoreGoogleDrive")
          ?.addEventListener("click", () => {
            window.location.href = "/api/google/restore";
          });
        return;
      }

      const data = await request("/api/google/files");
      const files = Array.isArray(data.files) ? data.files : [];
      body.innerHTML = `
        <section class="drawer-section">
          <div class="permission-default">${text("Свързан е достъп само за четене. Поддържа PDF, Google Docs, Word, текст, Google Sheets, Excel и снимки.")}</div>
          ${
            files.length
              ? files
                  .map(
                    (file) => `
            <article class="permission-card">
              <button type="button" data-drive-file="${escapeHtml(file.id)}" data-drive-name="${escapeHtml(file.name)}" style="text-align:left;background:none;border:0;padding:0;color:inherit">
                <strong>${escapeHtml(file.name)}</strong>
                <p>${file.modifiedTime ? new Date(file.modifiedTime).toLocaleDateString(globalThis.NovariumLocale?.browserLocale || "bg-BG") : text("Файл от Google Drive")}</p>
              </button>
              <button type="button" data-drive-file="${escapeHtml(file.id)}" data-drive-name="${escapeHtml(file.name)}">${text("Отвори текста")}</button>
            </article>`,
                  )
                  .join("")
              : `<div class="drawer-empty">${text("Няма намерени поддържани файлове.")}</div>`
          }
          <div class="permission-default drawer-note"><a href="/api/google/connect?add=drive">${text("Ако не виждаш всичките си файлове, натисни тук и разреши целия Drive в Google.")}</a></div>
          <div class="drawer-actions">
            <button type="button" id="openMyMail">${text("Пощата ми")}</button>
            <button type="button" id="openMyCalendar">${text("Календарът ми")}</button>
            <button type="button" id="disconnectGoogleDrive">${text("Прекъсни връзката")}</button>
          </div>
        </section>`;
    } catch (error) {
      // "Свържи Google" does not open the whole Drive: the connection works
      // for the calendar, contacts and email, so say that, not an error.
      if (connected && error.code === "GOOGLE_SCOPE_REQUIRED") {
        body.innerHTML = `
          <section class="drawer-section">
            <div class="permission-default">${text("Google е свързан. В разговора можеш да питаш за пощата, календара и контактите си, да добавяш събития и контакти и да пращаш имейли. Събитие, контакт и имейл до адрес, който сам напишеш, стават веднага с твоите думи. Писмо местиш в кошчето от панела Gmail с второ натискане.")}</div>
            <div class="permission-default">${text("Файловете ти в Drive не се виждат. „Запази в Google“ под отговор прави документ, до който NovariumAI има достъп.")}</div>
            <div class="drawer-actions">
              <button type="button" id="openMyCalendar">${text("Календарът ми")}</button>
              <button type="button" id="disconnectGoogleDrive">${text("Прекъсни връзката")}</button>
            </div>
          </section>`;
        return;
      }
      // Other errors (Google busy, expired sign-in) keep their own message.
      body.innerHTML = `<div class="drawer-state drawer-error">${escapeHtml(plainMessage(error.message))}</div>${
        connected && RECONNECT_CODES.has(error.code)
          ? `<a class="new-chat" href="/api/google/connect"><i class="fa-brands fa-google"></i><span>${text("Свържи Google отново")}</span></a>`
          : ""
      }`;
    }
  }

  body.addEventListener("click", async (event) => {
    const fileButton = event.target.closest("[data-drive-file]");
    if (fileButton) {
      const fileId = fileButton.dataset.driveFile;
      const fileName = fileButton.dataset.driveName;
      fileButton.disabled = true;
      fileButton.textContent = text("Анализирам…");
      try {
        const data = await request("/api/google/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fileId,
            prompt:
              "Обобщи документа на български. Изведи най-важните факти, срокове, суми и действия, които трябва да предприема.",
          }),
        });
        lastAnalysis = data.analysis || "";
        body.innerHTML = `
          <section class="drawer-section">
            <h3>${escapeHtml(data.fileName || fileName)}</h3>
            <div class="permission-default" style="white-space:pre-wrap">${escapeHtml(lastAnalysis)}</div>
            <button type="button" id="sendDriveAnalysis">${text("Изпрати в разговора")}</button>
            <button type="button" id="backToDriveFiles">${text("Назад към файловете")}</button>
          </section>`;
      } catch (error) {
        fileButton.disabled = false;
        fileButton.textContent = text("Анализирай");
        alert(error.message);
      }
      return;
    }

    if (event.target.closest("#openMyMail")) {
      document.getElementById("gmailBtn")?.click();
      return;
    }
    if (event.target.closest("#openMyCalendar")) {
      document.getElementById("googleCalendarBtn")?.click();
      return;
    }
    if (event.target.closest("#sendDriveAnalysis")) {
      const chatInput = document.getElementById("chatInput");
      const sendButton = document.getElementById("sendBtn");
      if (chatInput && sendButton && lastAnalysis) {
        chatInput.value = `Анализ на документ от Google Drive:\n\n${lastAnalysis}`;
        chatInput.dispatchEvent(new Event("input", { bubbles: true }));
        drawer.hidden = true;
        drawerBackdrop.hidden = true;
        sendButton.disabled = false;
        sendButton.click();
      }
      return;
    }

    if (event.target.closest("#backToDriveFiles")) {
      renderDrive();
      return;
    }

    const disconnect = event.target.closest("#disconnectGoogleDrive");
    if (disconnect) {
      disconnect.disabled = true;
      let failed = false;
      try {
        await request("/api/google/disconnect", { method: "POST" });
      } catch {
        failed = true;
      }
      await renderDrive();
      if (failed) {
        body.insertAdjacentHTML(
          "afterbegin",
          `<div class="drawer-state drawer-error">${escapeHtml(text("Връзката с Google не се прекъсна. Опитай отново."))}</div>`,
        );
      }
    }
  });

  button.addEventListener("click", renderDrive);

  const params = new URLSearchParams(window.location.search);
  if (params.has("google")) {
    const outcome = params.get("google");
    const notice =
      outcome === "partial"
        ? text("Google не даде всички разрешения, затова остава старата връзка. Свържи отново и отметни всички.")
        : outcome === "error" && params.get("reason") === "account"
          ? text("Избери същия Google профил, с който е свързан NovariumAI.")
          : outcome === "error"
            ? text("Връзката с Google не стана. Опитай отново.")
            : "";
    history.replaceState({}, "", window.location.pathname);
    renderDrive().then(() => {
      if (notice) {
        body.insertAdjacentHTML(
          "afterbegin",
          `<div class="drawer-state drawer-error">${escapeHtml(notice)}</div>`,
        );
      }
    });
  }
})();
