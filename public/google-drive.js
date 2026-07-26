(() => {
  const button = document.getElementById("googleDriveBtn");
  const drawer = document.getElementById("dataDrawer");
  const drawerBackdrop = document.getElementById("drawerBackdrop");
  const title = document.getElementById("dataDrawerTitle");
  const body = document.getElementById("dataDrawerBody");
  const sidebar = document.getElementById("sidebar");

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
    if (!response.ok) throw new Error(data.error || "Google Drive временно не е достъпен.");
    return data;
  }

  async function renderDrive() {
    openDrawer();
    body.innerHTML = '<div class="drawer-state"><i class="fa-solid fa-circle-notch fa-spin"></i> Зареждане…</div>';
    try {
      const status = await request("/api/google/status");
      if (!status.connected) {
        body.innerHTML = `
          <section class="drawer-section">
            <div class="permission-default">Synchron-X ще има достъп само за четене на избраните от теб файлове.</div>
            <button type="button" class="new-chat" id="connectGoogleDrive">
              <i class="fa-brands fa-google-drive"></i><span>Свържи Google Drive</span>
            </button>
          </section>`;
        document.getElementById("connectGoogleDrive").addEventListener("click", () => {
          window.location.href = "/api/google/connect";
        });
        return;
      }

      const data = await request("/api/google/files");
      const files = Array.isArray(data.files) ? data.files : [];
      body.innerHTML = `
        <section class="drawer-section">
          <div class="permission-default">Свързан е достъп само за четене. Избери PDF за анализ.</div>
          ${files.length ? files.map((file) => `
            <article class="permission-card">
              <div>
                <strong>${escapeHtml(file.name)}</strong>
                <p>${file.modifiedTime ? new Date(file.modifiedTime).toLocaleDateString("bg-BG") : "PDF документ"}</p>
              </div>
              <button type="button" data-drive-file="${escapeHtml(file.id)}" data-drive-name="${escapeHtml(file.name)}">Анализирай</button>
            </article>`).join("") : '<div class="drawer-empty">Няма намерени PDF документи.</div>'}
          <button type="button" id="disconnectGoogleDrive">Прекъсни връзката</button>
        </section>`;
    } catch (error) {
      body.innerHTML = `<div class="drawer-state drawer-error">${escapeHtml(error.message)}</div>`;
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
            prompt: "Обобщи документа на български. Изведи най-важните факти, срокове, суми и действия, които трябва да предприема.",
          }),
        });
        body.innerHTML = `
          <section class="drawer-section">
            <h3>${escapeHtml(data.fileName || fileName)}</h3>
            <div class="permission-default" style="white-space:pre-wrap">${escapeHtml(data.analysis)}</div>
            <button type="button" id="backToDriveFiles">Назад към PDF файловете</button>
          </section>`;
      } catch (error) {
        fileButton.disabled = false;
        fileButton.textContent = "Анализирай";
        alert(error.message);
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
