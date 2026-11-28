(() => {
  // "Моите задачи": a plain list for every account. A spoken or typed note
  // becomes suggested tasks; the person keeps the ones they want.
  const text = (value) => globalThis.NovariumLocale?.text?.(value) ?? value;
  const dialog = document.createElement("div");
  dialog.className = "share-dialog todo-dialog";
  dialog.hidden = true;
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.innerHTML = `
    <div class="share-card">
      <div class="share-head"><h2></h2><button type="button" class="share-close"></button></div>
      <p class="share-note"></p>
      <div class="todo-note-box">
        <textarea id="todoNote" class="todo-note" rows="3" maxlength="4000"></textarea>
        <div class="share-actions">
          <button type="button" class="todo-record"><i class="fa-solid fa-microphone" aria-hidden="true"></i> <span></span></button>
          <button type="button" class="todo-make primary"></button>
        </div>
      </div>
      <div class="todo-suggestions" hidden>
        <ul></ul>
        <div class="share-actions"><button type="button" class="todo-keep primary"></button></div>
      </div>
      <form class="todo-add">
        <input id="todoAdd" type="text" maxlength="240" autocomplete="off" />
        <button type="submit"></button>
      </form>
      <ul class="todo-list"></ul>
      <p class="todo-done-count"></p>
      <p class="share-status" role="status"></p>
    </div>`;
  document.body.appendChild(dialog);
  const $ = (selector) => dialog.querySelector(selector);
  $("h2").textContent = text("Моите задачи");
  $(".share-close").textContent = "✕";
  $(".share-close").setAttribute("aria-label", text("Затвори"));
  $(".share-note").textContent = text(
    "Кажи или напиши бележка и аватарът ще я направи на задачи. Ти избираш кои да запазиш. Списъкът е само твой.",
  );
  $(".todo-note").placeholder = text("Например: утре да се обадя на счетоводителя, да платя тока до петък и да купя подарък на мама.");
  $(".todo-record span").textContent = text("Гласова бележка");
  $(".todo-make").textContent = text("Направи задачи");
  $(".todo-keep").textContent = text("Запази избраните");
  $("#todoAdd").placeholder = text("Нова задача");
  $(".todo-add button").textContent = text("Добави");
  const status = (message) => ($(".share-status").textContent = message || "");

  const call = async (method, path = "", body) => {
    const response = await fetch(`/api/todos${path}`, {
      method,
      credentials: "same-origin",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || text("Нещо се обърка. Опитай отново."));
    return data;
  };

  const renderList = (items = []) => {
    const open = items.filter((item) => !item.done);
    const done = items.length - open.length;
    $(".todo-list").replaceChildren(
      ...open.map((item) => {
        const row = document.createElement("li");
        const label = document.createElement("label");
        const box = document.createElement("input");
        box.type = "checkbox";
        box.dataset.id = item.id;
        box.className = "todo-check";
        box.setAttribute("aria-label", text("Готово"));
        const words = document.createElement("span");
        words.textContent = item.text;
        label.append(box, words);
        // The day the person named („утре“), as 29.11.2026.
        if (/^\d{4}-\d{2}-\d{2}$/u.test(item.due || "")) {
          const due = document.createElement("small");
          due.className = "todo-due";
          due.textContent = ` · ${item.due.slice(8, 10)}.${item.due.slice(5, 7)}.${item.due.slice(0, 4)}`;
          label.append(due);
        }
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "todo-remove";
        remove.dataset.id = item.id;
        remove.textContent = "✕";
        remove.setAttribute("aria-label", text("Изтрий задачата"));
        row.append(label, remove);
        return row;
      }),
    );
    if (!open.length) {
      const empty = document.createElement("li");
      empty.className = "todo-empty";
      empty.textContent = text("Нямаш отворени задачи.");
      $(".todo-list").appendChild(empty);
    }
    $(".todo-done-count").textContent = done ? `${text("Готови")}: ${done}` : "";
  };
  const run = async (work, busy) => {
    status(busy);
    try {
      await work();
      status("");
    } catch (error) {
      status(error.message);
    }
  };

  $(".todo-list").addEventListener("change", (event) => {
    const box = event.target.closest(".todo-check");
    if (box) void run(async () => renderList((await call("PATCH", `/${encodeURIComponent(box.dataset.id)}`, { done: box.checked })).items), "");
  });
  $(".todo-list").addEventListener("click", (event) => {
    const button = event.target.closest(".todo-remove");
    if (button) void run(async () => renderList((await call("DELETE", `/${encodeURIComponent(button.dataset.id)}`)).items), "");
  });
  $(".todo-add").addEventListener("submit", (event) => {
    event.preventDefault();
    const value = $("#todoAdd").value.trim();
    if (!value) return;
    void run(async () => {
      renderList((await call("POST", "", { items: [value] })).items);
      $("#todoAdd").value = "";
    }, text("Записване…"));
  });
  $(".todo-make").addEventListener("click", () => {
    const note = $(".todo-note").value.trim();
    if (!note) {
      status(text("Кажи или напиши бележка първо."));
      return;
    }
    void run(async () => {
      const { suggestions = [] } = await call("POST", "/from-note", { note });
      if (!suggestions.length) throw new Error(text("Не намерих задачи в бележката."));
      $(".todo-suggestions ul").replaceChildren(
        ...suggestions.map((suggestion) => {
          const row = document.createElement("li");
          const label = document.createElement("label");
          const box = document.createElement("input");
          box.type = "checkbox";
          box.checked = true;
          box.value = suggestion;
          const words = document.createElement("span");
          words.textContent = suggestion;
          label.append(box, words);
          row.appendChild(label);
          return row;
        }),
      );
      $(".todo-suggestions").hidden = false;
    }, text("Подреждам задачите…"));
  });
  $(".todo-keep").addEventListener("click", () => {
    const chosen = [...dialog.querySelectorAll(".todo-suggestions input:checked")].map((box) => box.value);
    if (!chosen.length) {
      status(text("Избери поне една задача."));
      return;
    }
    void run(async () => {
      renderList((await call("POST", "", { items: chosen })).items);
      $(".todo-suggestions").hidden = true;
      $(".todo-note").value = "";
    }, text("Записване…"));
  });

  // Voice note: record until pressed again, then the server writes it down.
  let recorder = null;
  const recordButton = $(".todo-record");
  if (!(globalThis.MediaRecorder && navigator.mediaDevices?.getUserMedia)) recordButton.hidden = true;
  const transcribe = async (blob) => {
    const audio = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    const response = await fetch("/api/voice/transcribe", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audio, mimeType: blob.type, language: globalThis.NovariumLocale?.language || "bg" }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || text("Записът не можа да се разпознае."));
    return String(data.text || "").trim();
  };
  recordButton.addEventListener("click", async () => {
    if (recorder?.state === "recording") {
      recorder.stop();
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      status(text("Микрофонът е забранен за сайта. Разреши го от настройките на браузъра."));
      return;
    }
    const chunks = [];
    recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (event) => event.data?.size && chunks.push(event.data);
    recorder.onstop = () => {
      stream.getTracks().forEach((track) => track.stop());
      recordButton.classList.remove("listening");
      $(".todo-record span").textContent = text("Гласова бележка");
      const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
      recorder = null;
      if (blob.size < 1000) return;
      void run(async () => {
        const heard = await transcribe(blob);
        if (!heard) throw new Error(text("Не чух говор в записа."));
        const area = $(".todo-note");
        area.value = area.value.trim() ? `${area.value.trim()} ${heard}` : heard;
      }, text("Разпознаване…"));
    };
    recorder.start();
    recordButton.classList.add("listening");
    $(".todo-record span").textContent = text("Спри записа");
    status(text("Записвам… натисни пак, когато свършиш."));
  });

  const close = () => {
    if (recorder?.state === "recording") recorder.stop();
    dialog.hidden = true;
  };
  $(".share-close").addEventListener("click", close);
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !dialog.hidden) close();
  });
  document.addEventListener("novarium:todos", () => {
    dialog.hidden = false;
    void run(async () => renderList((await call("GET")).items), text("Зареждане…"));
  });
})();
