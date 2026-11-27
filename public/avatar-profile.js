(() => {
  // "Моят аватар": the person tells their avatar who they are, how they speak,
  // their goals, habits and limits. Saved per account and used in every answer.
  const text = (value) => globalThis.NovariumLocale?.text?.(value) ?? value;
  const HINTS = {
    about: "Например: казвам се Мария, счетоводител съм, живея в Пловдив, имам две деца.",
    style: "Например: кратко и директно, без сложни думи, с малко хумор.",
    goals: "Например: да отворя собствена кантора до края на годината; да спортувам три пъти седмично.",
    habits: "Например: ставам в 6:30, най-добре работя сутрин, в неделя не работя.",
    limits: "Например: не изпращай нищо от мое име без да питаш; не ми предлагай кредити.",
  };

  const dialog = document.createElement("div");
  dialog.className = "share-dialog avatar-dialog";
  dialog.hidden = true;
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.innerHTML = `
    <div class="share-card">
      <div class="share-head"><h2></h2><button type="button" class="share-close" aria-label="${text("Затвори")}">✕</button></div>
      <p class="share-note"></p>
      <form class="avatar-form"></form>
      <p class="share-status" role="status"></p>
      <div class="share-actions">
        <button type="button" class="avatar-clear"></button>
        <button type="button" class="avatar-save primary"></button>
      </div>
    </div>`;
  document.body.appendChild(dialog);
  const $ = (selector) => dialog.querySelector(selector);
  $("h2").textContent = text("Моят аватар");
  $(".share-note").textContent = text(
    "Разкажи на аватара си за себе си. Той ползва това във всеки отговор, за да говори и мисли по твоя начин. Виждаш го само ти и можеш да го промениш или изтриеш по всяко време. Аватарът предлага и подготвя, решаваш ти.",
  );
  $(".avatar-save").textContent = text("Запази");
  $(".avatar-clear").textContent = text("Изтрий всичко");
  const status = (message) => ($(".share-status").textContent = message || "");

  const call = async (method, body) => {
    const response = await fetch("/api/avatar-profile", {
      method,
      credentials: "same-origin",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || text("Нещо се обърка. Опитай отново."));
    return data;
  };
  const render = ({ profile = {}, fields = [] }) => {
    $(".avatar-form").replaceChildren(
      ...fields.map(({ id, label, max }) => {
        const wrap = document.createElement("label");
        const title = document.createElement("span");
        title.textContent = text(label);
        const area = document.createElement("textarea");
        area.name = id;
        area.rows = 3;
        area.maxLength = max;
        area.placeholder = text(HINTS[id] || "");
        area.value = profile[id] || "";
        wrap.append(title, area);
        return wrap;
      }),
    );
  };
  const values = () =>
    Object.fromEntries([...dialog.querySelectorAll(".avatar-form textarea")].map((area) => [area.name, area.value]));
  const save = async (profile, done) => {
    status(text("Записване…"));
    try {
      render(await call("PUT", { profile }));
      status(done);
    } catch (error) {
      status(error.message);
    }
  };

  $(".avatar-save").addEventListener("click", () => save(values(), text("Записано. Аватарът вече те познава по-добре.")));
  $(".avatar-clear").addEventListener("click", () => save({}, text("Профилът е изтрит.")));
  const close = () => (dialog.hidden = true);
  $(".share-close").addEventListener("click", close);
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !dialog.hidden) close();
  });
  document.addEventListener("novarium:avatar-profile", async () => {
    dialog.hidden = false;
    status(text("Зареждане…"));
    try {
      render(await call("GET"));
      status("");
    } catch (error) {
      status(error.message);
    }
  });
})();
