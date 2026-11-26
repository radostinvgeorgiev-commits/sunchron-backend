(() => {
  // "Добавки": every person can write a small program, try it in a closed
  // sandbox and send it for review. The store shows only approved add-ons.
  const text = (value) => globalThis.AiCoreLocale?.text?.(value) ?? value;
  const isOwner = () => document.body.dataset.userRole === "owner";
  const EXAMPLE = {
    name: "Времето в София",
    description: "Показва времето сега в София.",
    dataUrl: "https://api.open-meteo.com/v1/forecast?latitude=42.70&longitude=23.32&current_weather=true",
    code: [
      "// input е това, което човекът пише; data идва от адреса за данни.",
      "function run(input, data) {",
      "  const now = data.current_weather;",
      "  return `Сега в София: ${now.temperature}°C, вятър ${now.windspeed} км/ч.`;",
      "}",
    ].join("\n"),
  };

  const dialog = document.createElement("div");
  dialog.className = "share-dialog addon-dialog";
  dialog.hidden = true;
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.innerHTML = `
    <div class="share-card addon-card">
      <div class="share-head"><h2></h2><button type="button" class="share-close"></button></div>
      <div class="addon-tabs" role="tablist">
        <button type="button" role="tab" data-tab="store"></button>
        <button type="button" role="tab" data-tab="mine"></button>
        <button type="button" role="tab" data-tab="review"></button>
      </div>
      <section data-pane="store"><p class="share-note"></p><ul class="addon-list"></ul></section>
      <section data-pane="mine" hidden>
        <p class="share-note"></p>
        <form class="addon-editor">
          <input type="hidden" name="id" />
          <label><span data-label="name"></span><input name="name" maxlength="60" autocomplete="off" /></label>
          <label><span data-label="description"></span><input name="description" maxlength="300" autocomplete="off" /></label>
          <label><span data-label="dataUrl"></span><input name="dataUrl" maxlength="500" inputmode="url" autocomplete="off" placeholder="https://…" /></label>
          <label><span data-label="code"></span><textarea name="code" rows="9" spellcheck="false" maxlength="20000"></textarea></label>
          <label><span data-label="input"></span><input name="input" maxlength="4000" autocomplete="off" /></label>
          <div class="share-actions">
            <button type="button" class="addon-new"></button>
            <button type="button" class="addon-test"></button>
            <button type="submit" class="primary addon-save"></button>
          </div>
        </form>
        <pre class="addon-output" hidden></pre>
        <ul class="addon-list addon-mine"></ul>
      </section>
      <section data-pane="review" hidden><p class="share-note"></p><ul class="addon-list addon-review"></ul></section>
      <p class="share-status" role="status"></p>
    </div>`;
  document.body.appendChild(dialog);
  const $ = (selector) => dialog.querySelector(selector);
  const form = $(".addon-editor");
  $("h2").textContent = text("Добавки");
  $(".share-close").textContent = "✕";
  $(".share-close").setAttribute("aria-label", text("Затвори"));
  $('[data-tab="store"]').textContent = text("Магазин");
  $('[data-tab="mine"]').textContent = text("Моите добавки");
  $('[data-tab="review"]').textContent = text("За преглед");
  $('[data-pane="store"] .share-note').textContent = text(
    "Добавки, направени от хората и одобрени. Всяка работи в затворена среда и не вижда твоите данни.",
  );
  $('[data-pane="mine"] .share-note').textContent = text(
    "Напиши функция run(input, data). Тя работи в затворена среда без достъп до интернет и до данните ти. Ако посочиш адрес за данни, сайтът го чете и подава резултата като data; {input} в адреса се заменя с това, което напишеш. Добавката е само твоя, докато не я изпратиш за преглед.",
  );
  $('[data-pane="review"] .share-note').textContent = text("Прочети кода, пробвай и реши. Одобрената добавка се вижда от всички.");
  const labels = {
    name: "Име",
    description: "Какво прави",
    dataUrl: "Адрес за данни (по желание)",
    code: "Код (JavaScript)",
    input: "Проба: какво пише човекът",
  };
  for (const [key, value] of Object.entries(labels)) $(`[data-label="${key}"]`).textContent = text(value);
  $(".addon-new").textContent = text("Нова");
  $(".addon-test").textContent = text("Пробвай");
  $(".addon-save").textContent = text("Запази");
  const status = (message) => ($(".share-status").textContent = message || "");

  const call = async (method, path, body) => {
    const response = await fetch(`/api/addons${path}`, {
      method,
      credentials: "same-origin",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || text("Нещо се обърка. Опитай отново."));
    return data;
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
  const element = (tag, className, content) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = content;
    return node;
  };
  const button = (label, action, id, primary = false) => {
    const node = element("button", primary ? "primary" : "", text(label));
    node.type = "button";
    node.dataset.action = action;
    node.dataset.id = id;
    return node;
  };
  // A result box with "Прати в чата" so the answer can go on in the chat.
  const showResult = (box, result) => {
    box.hidden = false;
    const lines = [];
    if (result.logs?.length) lines.push(`log:\n${result.logs.join("\n")}`);
    lines.push(result.ok ? result.output : `⚠ ${result.error}`);
    box.textContent = lines.join("\n\n");
    box.dataset.output = result.ok ? result.output : "";
  };
  const resultBox = () => {
    const box = element("pre", "addon-output");
    box.hidden = true;
    return box;
  };
  const toChat = (output) => {
    const input = document.getElementById("chatInput");
    if (!input || !output) return;
    input.value = input.value.trim() ? `${input.value.trim()}\n\n${output}` : output;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    close();
    input.focus();
  };

  const card = (item, actions, { showCode = false, status: badge, note = false } = {}) => {
    const row = element("li", "addon-item");
    const head = element("div", "addon-item-head");
    head.append(element("strong", "", item.name));
    if (badge) head.append(element("span", `addon-badge addon-${badge}`, text(STATUS[badge] || badge)));
    row.append(head);
    if (item.description) row.append(element("p", "addon-desc", item.description));
    if (item.dataUrl) row.append(element("p", "addon-url", `${text("Чете от")}: ${item.dataUrl}`));
    if (item.reviewNote) row.append(element("p", "addon-desc", `${text("Бележка от прегледа")}: ${item.reviewNote}`));
    if (showCode) {
      const details = element("details");
      details.append(element("summary", "", text("Виж кода")), element("pre", "addon-code", item.code));
      row.append(details);
    }
    const input = element("input", "addon-input");
    input.placeholder = text("Какво да получи добавката (по желание)");
    input.maxLength = 4000;
    const bar = element("div", "share-actions");
    bar.append(...actions);
    row.append(input);
    if (note) {
      const noteInput = element("input", "addon-note");
      noteInput.placeholder = text("Бележка към автора (по желание)");
      noteInput.maxLength = 300;
      row.append(noteInput);
    }
    row.append(bar, resultBox());
    return row;
  };
  const STATUS = { draft: "Само за мен", pending: "Чака преглед", public: "В магазина", rejected: "Отказана" };

  const loadStore = async () => {
    const { items = [] } = await call("GET", "/store");
    const list = $('[data-pane="store"] .addon-list');
    list.replaceChildren(
      ...items.map((item) => card(item, [button("Пусни", "run-store", item.id, true)], { showCode: true })),
    );
    if (!items.length) list.append(element("li", "todo-empty", text("Още няма одобрени добавки. Направи първата в „Моите добавки“.")));
  };
  let mine = [];
  const loadMine = async (items) => {
    mine = items || (await call("GET", "/mine")).items || [];
    $(".addon-mine").replaceChildren(
      ...mine.map((item) => {
        const actions = [button("Пусни", "run-mine", item.id, true), button("Промени", "edit", item.id)];
        if (item.status === "draft" || item.status === "rejected") actions.push(button("Изпрати за преглед", "submit", item.id));
        if (item.published) actions.push(button("Махни от магазина", "unpublish", item.id));
        actions.push(button("Изтрий", "delete", item.id));
        return card(item, actions, { status: item.status });
      }),
    );
  };
  const loadReview = async () => {
    const { items = [] } = await call("GET", "/review");
    const list = $(".addon-review");
    list.replaceChildren(
      ...items.map((item) =>
        card(item, [button("Пробвай", "run-review", item.id), button("Откажи", "reject", item.id), button("Одобри", "approve", item.id, true)], {
          showCode: true,
          note: true,
        }),
      ),
    );
    if (!items.length) list.append(element("li", "todo-empty", text("Няма добавки за преглед.")));
  };

  const showTab = (name) => {
    for (const tab of dialog.querySelectorAll("[data-tab]")) tab.setAttribute("aria-selected", String(tab.dataset.tab === name));
    for (const pane of dialog.querySelectorAll("[data-pane]")) pane.hidden = pane.dataset.pane !== name;
    if (name === "store") void run(loadStore, text("Зареждане…"));
    if (name === "mine") void run(() => loadMine(), text("Зареждане…"));
    if (name === "review") void run(loadReview, text("Зареждане…"));
  };
  $(".addon-tabs").addEventListener("click", (event) => {
    const tab = event.target.closest("[data-tab]");
    if (tab) showTab(tab.dataset.tab);
  });

  const fill = (item) => {
    for (const key of ["id", "name", "description", "dataUrl", "code"]) form.elements[key].value = item?.[key] || "";
    $(".addon-output").hidden = true;
  };
  const draft = () => Object.fromEntries(["id", "name", "description", "dataUrl", "code"].map((key) => [key, form.elements[key].value]));
  $(".addon-new").addEventListener("click", () => fill(EXAMPLE));
  $(".addon-test").addEventListener("click", () =>
    void run(async () => showResult($(".addon-output"), await call("POST", "/test", { ...draft(), input: form.elements.input.value })), text("Пускам в затворената среда…")),
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void run(async () => {
      const { item, items } = await call("POST", "/mine", draft());
      form.elements.id.value = item.id;
      await loadMine(items);
      status(text("Записано. Вижда я само ти, докато не я изпратиш за преглед."));
    }, text("Записване…"));
    return false;
  });

  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) return close();
    const target = event.target.closest("[data-action]");
    if (!target) return;
    const { action, id } = target.dataset;
    const row = target.closest(".addon-item");
    const input = row?.querySelector(".addon-input")?.value || "";
    const box = row?.querySelector("pre.addon-output");
    const path = encodeURIComponent(id);
    if (action === "to-chat") return toChat(box?.dataset.output);
    const runInto = (url) =>
      run(async () => {
        showResult(box, await call("POST", url, { input }));
        if (box.dataset.output && !row.querySelector('[data-action="to-chat"]')) {
          row.querySelector(".share-actions").append(button("Прати в чата", "to-chat", id));
        }
      }, text("Пускам в затворената среда…"));
    if (action === "run-store") return void runInto(`/store/${path}/run`);
    if (action === "run-mine") return void runInto(`/mine/${path}/run`);
    if (action === "run-review") return void runInto(`/review/${path}/run`);
    if (action === "edit") {
      fill(mine.find((item) => item.id === id));
      form.scrollIntoView({ block: "start", behavior: "smooth" });
      return undefined;
    }
    if (action === "submit") {
      return void run(async () => {
        await loadMine((await call("POST", `/mine/${path}/submit`)).items);
        status(text("Изпратено за преглед."));
      }, text("Изпращане…"));
    }
    if (action === "unpublish") return void run(async () => loadMine((await call("POST", `/mine/${path}/unpublish`)).items), "");
    if (action === "delete") {
      if (target.dataset.sure !== "1") {
        target.dataset.sure = "1";
        target.textContent = text("Сигурен ли си? Натисни пак");
        return undefined;
      }
      return void run(async () => {
        await loadMine((await call("DELETE", `/mine/${path}`)).items);
        if (form.elements.id.value === id) fill(null);
      }, "");
    }
    if (action === "approve" || action === "reject") {
      return void run(async () => {
        await call("POST", `/review/${path}/${action}`, { note: row.querySelector(".addon-note")?.value || "" });
        await loadReview();
        status(text(action === "approve" ? "Одобрена. Вече е в магазина." : "Отказана."));
      }, "");
    }
    return undefined;
  });

  function close() {
    dialog.hidden = true;
  }
  $(".share-close").addEventListener("click", close);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !dialog.hidden) close();
  });
  document.addEventListener("aicore:addons", () => {
    $('[data-tab="review"]').hidden = !isOwner();
    if (!form.elements.code.value) fill(EXAMPLE);
    dialog.hidden = false;
    showTab("store");
  });
})();
