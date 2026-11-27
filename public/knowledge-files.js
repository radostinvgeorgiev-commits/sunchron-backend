(() => {
  // "Моите файлове": the person's knowledge base. Files added here are
  // searched on every question and matching passages go to the AI.
  const text = (value) => globalThis.NovariumLocale?.text?.(value) ?? value;
  const TEXT_TYPES = /\.(txt|md|csv|json|log|html?|xml|ya?ml)$/iu;
  const MAX_PDF_BYTES = 4 * 1024 * 1024;

  const dialog = document.createElement("div");
  dialog.className = "share-dialog knowledge-dialog";
  dialog.hidden = true;
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.innerHTML = `
    <div class="share-card">
      <div class="share-head"><h2></h2><button type="button" class="share-close" aria-label="${text("Затвори")}">✕</button></div>
      <p class="share-note"></p>
      <ul class="knowledge-list"></ul>
      <p class="share-status" role="status"></p>
      <div class="share-actions">
        <input type="file" class="knowledge-input" accept=".txt,.md,.csv,.json,.pdf,text/plain,application/pdf" hidden />
        <input type="file" class="archive-input" accept=".zip,application/zip" hidden />
        <button type="button" class="archive-add"></button>
        <button type="button" class="knowledge-add primary"></button>
      </div>
    </div>`;
  document.body.appendChild(dialog);
  const $ = (selector) => dialog.querySelector(selector);
  $("h2").textContent = text("Моите файлове");
  $(".share-note").textContent = text(
    "Добави текстови файлове или PDF. При всеки въпрос Novarium търси в тях и ползва намереното. Виждаш ги само ти и можеш да ги изтриеш по всяко време.",
  );
  $(".knowledge-add").textContent = text("Добави файл");
  $(".archive-add").textContent = text("Внеси архив (Facebook, Instagram, LinkedIn, X, Google, ChatGPT, Claude)");
  $(".archive-add").title = text(
    "Архивът се отваря в браузъра ти. Пазят се само твоите публикации, коментари, написаното от теб в чатове, работата и уменията ти от LinkedIn, бележки от Keep, събития от Календара и твоите въпроси към ChatGPT и Claude (без отговорите им); чуждите съобщения не излизат от устройството.",
  );
  const status = (message) => ($(".share-status").textContent = message || "");

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
  const render = (files) => {
    const list = $(".knowledge-list");
    if (!files.length) {
      const empty = document.createElement("li");
      empty.className = "knowledge-empty";
      empty.textContent = text("Още няма файлове.");
      list.replaceChildren(empty);
      return;
    }
    list.replaceChildren(
      ...files.map((file) => {
        const item = document.createElement("li");
        const name = document.createElement("span");
        name.textContent = `📄 ${file.name}`;
        const remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = text("Изтрий");
        remove.addEventListener("click", async () => {
          status(text("Изтриване…"));
          try {
            await call("DELETE", `/api/knowledge-files/${encodeURIComponent(file.id)}`);
            await load();
            status(text("Файлът е изтрит."));
          } catch (error) {
            status(error.message);
          }
        });
        item.append(name, remove);
        return item;
      }),
    );
  };
  const load = async () => render((await call("GET", "/api/knowledge-files")).files || []);
  const read = (file, how) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error);
      reader[how](file);
    });

  $(".knowledge-add").addEventListener("click", () => $(".knowledge-input").click());
  $(".knowledge-input").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const isPdf = file.type === "application/pdf" || /\.pdf$/iu.test(file.name);
      if (!isPdf && !TEXT_TYPES.test(file.name) && !file.type.startsWith("text/")) {
        throw new Error(text("Поддържат се текстови файлове и PDF."));
      }
      if (isPdf && file.size > MAX_PDF_BYTES) throw new Error(text("PDF файлът е твърде голям (до 4 MB)."));
      status(isPdf ? text("Чета PDF файла… това отнема до минута.") : text("Добавяне…"));
      await call(
        "POST",
        "/api/knowledge-files",
        isPdf
          ? { name: file.name, pdf: await read(file, "readAsDataURL") }
          : { name: file.name, text: await read(file, "readAsText") },
      );
      await load();
      status(text("Файлът е добавен. Novarium вече ще търси в него."));
    } catch (error) {
      status(error.message);
    }
  });
  // A personal archive is read in the browser; only the person's own texts
  // are sent, as separate files in "Моите файлове".
  $(".archive-add").addEventListener("click", () => $(".archive-input").click());
  $(".archive-input").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const reader = globalThis.NovariumArchive;
      if (!reader || typeof DecompressionStream === "undefined") {
        throw new Error(text("Този браузър не може да отвори архива. Опитай с по-нов Chrome, Edge или Safari."));
      }
      status(text("Отварям архива…"));
      const parts = await reader.readPersonalArchive(file, (done, total) =>
        status(`${text("Чета архива")}… ${done}/${total}`),
      );
      for (const [index, part] of parts.entries()) {
        status(`${text("Добавям")} ${index + 1}/${parts.length}: ${part.name}`);
        await call("POST", "/api/knowledge-files", part);
      }
      await load();
      status(`${text("Готово. Добавени са")} ${parts.length} ${text("файла от архива ти. Аватарът вече ги ползва.")}`);
    } catch (error) {
      status(error.message);
    }
  });
  const close = () => (dialog.hidden = true);
  $(".share-close").addEventListener("click", close);
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !dialog.hidden) close();
  });
  document.addEventListener("novarium:knowledge-files", async () => {
    dialog.hidden = false;
    status(text("Зареждане…"));
    try {
      await load();
      status("");
    } catch (error) {
      status(error.message);
    }
  });
})();
