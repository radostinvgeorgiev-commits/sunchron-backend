(() => {
  // "Share conversation" from the ⋯ menu, like ChatGPT and Claude: a
  // read-only link to a copy of the messages, which can be stopped any time.
  const button = document.getElementById("conversationShareBtn");
  if (!button) return;
  const text = (value) => globalThis.NovariumLocale?.text?.(value) ?? value;

  const dialog = document.createElement("div");
  dialog.className = "share-dialog";
  dialog.hidden = true;
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "shareDialogTitle");
  dialog.innerHTML = `
    <div class="share-card">
      <div class="share-head">
        <h2 id="shareDialogTitle"></h2>
        <button type="button" class="share-close" aria-label="${text("Затвори")}">✕</button>
      </div>
      <p class="share-note"></p>
      <div class="share-link" hidden>
        <input type="text" readonly aria-label="${text("Линк")}" />
        <button type="button" class="share-copy"></button>
      </div>
      <p class="share-status" role="status"></p>
      <div class="share-actions">
        <button type="button" class="share-stop" hidden></button>
        <button type="button" class="share-create primary"></button>
      </div>
    </div>`;
  document.body.appendChild(dialog);
  const $ = (selector) => dialog.querySelector(selector);
  $("#shareDialogTitle").textContent = text("Сподели разговора");
  $(".share-note").textContent = text(
    "Който има линка, вижда копие на съобщенията дотук, само за четене. Паметта, проектите и файловете не се показват. Новите съобщения след това не влизат в линка.",
  );
  $(".share-copy").textContent = text("Копирай");
  $(".share-stop").textContent = text("Спри линка");

  let sessionId = "";
  const setStatus = (message) => ($(".share-status").textContent = message || "");
  const showLink = (url) => {
    $(".share-link").hidden = !url;
    $(".share-link input").value = url || "";
    $(".share-stop").hidden = !url;
    $(".share-create").textContent = text(url ? "Нов линк с последните съобщения" : "Създай линк");
  };
  const call = async (method, path, body) => {
    const response = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || text("Нещо се обърка. Опитай отново."));
    return data;
  };
  const close = () => {
    dialog.hidden = true;
    button.focus();
  };

  button.addEventListener("click", async () => {
    document.getElementById("chatOptions")?.removeAttribute("open");
    sessionId = globalThis.SynchronChat?.sessionId?.() || "";
    showLink("");
    setStatus(text("Проверка…"));
    dialog.hidden = false;
    $(".share-create").focus();
    try {
      const data = await call("GET", `/api/share/${encodeURIComponent(sessionId)}`);
      showLink(data.shared ? data.url : "");
      setStatus(data.shared ? text("Разговорът е споделен.") : "");
    } catch (error) {
      setStatus(error.message);
    }
  });
  $(".share-create").addEventListener("click", async () => {
    setStatus(text("Създаване…"));
    try {
      const data = await call("POST", "/api/share", { sessionId });
      showLink(data.url);
      setStatus(text("Линкът е готов. Старият линк, ако е имало, вече не работи."));
    } catch (error) {
      setStatus(error.message);
    }
  });
  $(".share-stop").addEventListener("click", async () => {
    setStatus(text("Спиране…"));
    try {
      await call("DELETE", `/api/share/${encodeURIComponent(sessionId)}`);
      showLink("");
      setStatus(text("Линкът е спрян. Който го отвори, няма да види разговора."));
    } catch (error) {
      setStatus(error.message);
    }
  });
  $(".share-copy").addEventListener("click", async () => {
    const value = $(".share-link input").value;
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      $(".share-link input").select();
      document.execCommand("copy");
    }
    setStatus(text("Линкът е копиран."));
  });
  $(".share-close").addEventListener("click", close);
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !dialog.hidden) close();
  });
})();
