(() => {
  // "Питай моя аватар": the person writes what visitors may know and gets a
  // link. Only that text is used for visitors; the link can be stopped.
  const text = (value) => globalThis.AiCoreLocale?.text?.(value) ?? value;
  const dialog = document.createElement("div");
  dialog.className = "share-dialog avatar-link-dialog";
  dialog.hidden = true;
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.innerHTML = `
    <div class="share-card">
      <div class="share-head"><h2></h2><button type="button" class="share-close"></button></div>
      <p class="share-note"></p>
      <form class="avatar-form avatar-link-form">
        <label><span data-label="name"></span><input id="avatarLinkName" maxlength="60" autocomplete="off" /></label>
        <label><span data-label="intro"></span><input id="avatarLinkIntro" maxlength="300" autocomplete="off" /></label>
        <label><span data-label="knowledge"></span><textarea id="avatarLinkKnowledge" rows="7" maxlength="4000"></textarea></label>
      </form>
      <div class="share-link avatar-link-url" hidden>
        <input type="text" readonly aria-label="" />
        <button type="button" class="avatar-link-copy"></button>
      </div>
      <p class="avatar-link-usage"></p>
      <p class="share-status" role="status"></p>
      <div class="share-actions">
        <button type="button" class="avatar-link-stop" hidden></button>
        <button type="button" class="avatar-link-save primary"></button>
      </div>
    </div>`;
  document.body.appendChild(dialog);
  const $ = (selector) => dialog.querySelector(selector);
  $("h2").textContent = text("Питай моя аватар");
  $(".share-close").textContent = "✕";
  $(".share-close").setAttribute("aria-label", text("Затвори"));
  $(".share-note").textContent = text(
    "Дай линк на друг човек и той ще може да пита твоя аватар. Аватарът отговаря само с това, което напишеш тук. Паметта, файловете, пощата и разговорите ти не се ползват. Можеш да спреш линка по всяко време.",
  );
  $('[data-label="name"]').textContent = text("Как да се представя аватарът");
  $('[data-label="intro"]').textContent = text("Кратко представяне (по желание)");
  $('[data-label="knowledge"]').textContent = text("Какво аватарът може да казва за теб");
  $("#avatarLinkName").placeholder = text("Например: Мария Иванова");
  $("#avatarLinkIntro").placeholder = text("Например: счетоводител в Пловдив");
  $("#avatarLinkKnowledge").placeholder = text(
    "Например: с какво се занимавам, работно време, цени, как да се свържат с мен, често задавани въпроси. Не пиши нищо, което не искаш другите да знаят.",
  );
  $(".avatar-link-copy").textContent = text("Копирай");
  $(".avatar-link-url input").setAttribute("aria-label", text("Линк към аватара"));
  $(".avatar-link-stop").textContent = text("Спри линка");
  const status = (message) => ($(".share-status").textContent = message || "");

  const call = async (method, body) => {
    const response = await fetch("/api/avatar-link", {
      method,
      credentials: "same-origin",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || text("Нещо се обърка. Опитай отново."));
    return data;
  };
  const render = ({ active, url, card = {}, usedToday = 0, perDay = 0 }) => {
    $("#avatarLinkName").value = card.name || "";
    $("#avatarLinkIntro").value = card.intro || "";
    $("#avatarLinkKnowledge").value = card.knowledge || "";
    $(".avatar-link-url").hidden = !active;
    $(".avatar-link-url input").value = active ? url : "";
    $(".avatar-link-stop").hidden = !active;
    $(".avatar-link-save").textContent = text(active ? "Запази промените" : "Създай линк");
    $(".avatar-link-usage").textContent = active
      ? `${text("Въпроси днес")}: ${usedToday} / ${perDay}`
      : "";
  };
  // While the saved text loads or saves, the fields wait, so nothing typed
  // in the meantime is overwritten by the answer.
  const lock = (locked) =>
    dialog.querySelectorAll("input, textarea, .avatar-link-save, .avatar-link-stop").forEach((field) => {
      field.disabled = locked;
    });
  const run = async (work, busy, done = "") => {
    status(busy);
    lock(true);
    try {
      render(await work());
      status(done);
    } catch (error) {
      status(error.message);
    } finally {
      lock(false);
    }
  };

  $(".avatar-link-save").addEventListener("click", () =>
    run(
      () =>
        call("PUT", {
          card: {
            name: $("#avatarLinkName").value,
            intro: $("#avatarLinkIntro").value,
            knowledge: $("#avatarLinkKnowledge").value,
          },
        }),
      text("Записване…"),
      text("Готово. Копирай линка и го дай на когото искаш."),
    ),
  );
  $(".avatar-link-stop").addEventListener("click", () =>
    run(() => call("DELETE"), text("Спиране…"), text("Линкът е спрян. Текстът остава за следващия път.")),
  );
  $(".avatar-link-copy").addEventListener("click", async () => {
    const field = $(".avatar-link-url input");
    try {
      await navigator.clipboard.writeText(field.value);
      status(text("Линкът е копиран."));
    } catch {
      field.select();
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
  document.addEventListener("aicore:avatar-link", () => {
    dialog.hidden = false;
    void run(() => call("GET"), text("Зареждане…"));
  });
})();
