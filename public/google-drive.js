(() => {
  const button = document.getElementById("googleDriveBtn");
  const drawer = document.getElementById("dataDrawer");
  const drawerBackdrop = document.getElementById("drawerBackdrop");
  const title = document.getElementById("dataDrawerTitle");
  const body = document.getElementById("dataDrawerBody");
  const sidebar = document.getElementById("sidebar");
  let lastAnalysis = "";

  if (!button || !drawer || !body) return;

  const escapeHtml = (value) => {
    const div = document.createElement("div");
    div.textContent = String(value ?? "");
    return div.innerHTML;
  };

  function openDrawer() {
    title.textContent = "Google Drive";
    drawer.hidden = false;
    drawerBackdrop.hidden = false;
    sidebar.classList.remove("mobile-visible");
  }

  async function request(path, options) {
    const response = await fetch(path, { cache: "no-store", ...options });
    const data = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(data.error || "Google Drive временно не е достъпен.");
    return data;
  }

  async function renderDrive() {
    openDrawer();
    body.innerHTML =
      '<div class="drawer-state"><i class="fa-solid fa-circle-notch fa-spin"></i> Зареждане…</div>';
    let connected = false;
    try {
      const status = await request("/api/google/status");
      connected = Boolean(status.connected);
      if (!status.connected) {
        body.innerHTML = `
          <section class="drawer-section">
            <div class="permission-default">AI CORE ще има достъп само за четене на избраните от теб файлове.</div>
            <button type="button" class="new-chat" id="connectGoogleDrive">
              <i class="fa-brands fa-google-drive"></i><span>Свържи Google Drive</span>
            </button>
            ${
              status.canRestore
                ? `<button type="button" class="new-chat" id="restoreGoogleDrive">
              <i class="fa-solid fa-clock-rotate-left"></i><span>Възстанови старата Google връзка</span>
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
          <div class="permission-default">Свързан е достъп само за четене. Поддържа PDF, Google Docs, Word, текст, Google Sheets, Excel и снимки.</div>
          ${
            files.length
              ? files
                  .map(
                    (file) => `
            <article class="permission-card">
              <button type="button" data-drive-file="${escapeHtml(file.id)}" data-drive-name="${escapeHtml(file.name)}" style="text-align:left;background:none;border:0;padding:0;color:inherit">
                <strong>${escapeHtml(file.name)}</strong>
                <p>${file.modifiedTime ? new Date(file.modifiedTime).toLocaleDateString("bg-BG") : "Файл от Google Drive"}</p>
              </button>
              <button type="button" data-drive-file="${escapeHtml(file.id)}" data-drive-name="${escapeHtml(file.name)}">Отвори текста</button>
            </article>`,
                  )
                  .join("")
              : '<div class="drawer-empty">Няма намерени поддържани файлове.</div>'
          }
          <a class="permission-default" href="/api/google/connect?add=drive">Ако не виждаш всичките си файлове, натисни тук и разреши целия Drive в Google.</a>
          <button type="button" id="openMyMail">Пощата ми</button>
          <button type="button" id="openMyCalendar">Календарът ми</button>
          <button type="button" id="disconnectGoogleDrive">Прекъсни връзката</button>
        </section>`;
    } catch (error) {
      // A light Google connection has no Drive access yet: show the step
      // that adds it, not only the error.
      body.innerHTML = `<div class="drawer-state drawer-error">${escapeHtml(error.message)}</div>${
        connected
          ? '<a class="new-chat" href="/api/google/connect?add=drive"><i class="fa-brands fa-google-drive"></i><span>Разреши Google Drive</span></a>'
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
      fileButton.textContent = "Анализирам…";
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
            <button type="button" id="sendDriveAnalysis">Изпрати в разговора</button>
            <button type="button" id="backToDriveFiles">Назад към файловете</button>
          </section>`;
      } catch (error) {
        fileButton.disabled = false;
        fileButton.textContent = "Анализирай";
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

    if (event.target.closest("#disconnectGoogleDrive")) {
      await request("/api/google/disconnect", { method: "POST" });
      renderDrive();
    }
  });

  button.addEventListener("click", renderDrive);

  const params = new URLSearchParams(window.location.search);
  if (params.has("google")) {
    history.replaceState({}, "", window.location.pathname);
    renderDrive();
  }
})();
