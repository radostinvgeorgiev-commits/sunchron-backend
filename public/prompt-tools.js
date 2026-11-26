(() => {
  // Assistants (like GPTs in ChatGPT or bots in Poe) and "/" prompts (like
  // TypingMind and Open WebUI). Both only shape the request; the server
  // checks the assistant id against its own list.
  const $ = (id) => document.getElementById(id);
  const text = (value) => globalThis.AiCoreLocale?.text?.(value) ?? value;
  const input = $("chatInput");
  const composer = input?.closest(".composer-wrap");
  if (!input || !composer) return;

  // ---- Assistants -------------------------------------------------------
  let assistants = [];
  let current = null;
  const ui = () => globalThis.SynchronUi || (globalThis.SynchronUi = {});
  ui().assistant = () => current?.id || "";

  const chip = document.createElement("div");
  chip.className = "assistant-chip";
  chip.hidden = true;
  chip.innerHTML = `<i class="fa-solid" aria-hidden="true"></i><span></span>
    <button type="button" aria-label="${text("Махни асистента")}">✕</button>`;
  composer.prepend(chip);

  const picker = document.createElement("div");
  picker.className = "assistant-picker";
  picker.hidden = true;
  picker.setAttribute("role", "menu");
  composer.prepend(picker);

  const setAssistant = (assistant) => {
    current = assistant || null;
    chip.hidden = !current;
    if (current) {
      chip.querySelector("i").className = `fa-solid ${current.icon || "fa-user-tie"}`;
      chip.querySelector("span").textContent = `${text("Асистент")}: ${text(current.label)}`;
    }
  };
  chip.querySelector("button").addEventListener("click", () => setAssistant(null));
  $("newChatBtn")?.addEventListener("click", () => setAssistant(null));

  const renderPicker = () => {
    picker.replaceChildren(
      ...assistants.map((assistant) => {
        const item = document.createElement("button");
        item.type = "button";
        item.setAttribute("role", "menuitemradio");
        item.setAttribute("aria-checked", String(current?.id === assistant.id));
        item.innerHTML = `<i class="fa-solid" aria-hidden="true"></i><span><strong></strong><small></small></span>`;
        item.querySelector("i").classList.add(assistant.icon || "fa-user-tie");
        item.querySelector("strong").textContent = text(assistant.label);
        item.querySelector("small").textContent = text(assistant.hint || "");
        item.addEventListener("click", () => {
          setAssistant(assistant);
          picker.hidden = true;
          input.focus();
        });
        return item;
      }),
    );
  };
  document.addEventListener("aicore:pick-assistant", () => {
    if (!assistants.length) return;
    renderPicker();
    picker.hidden = false;
  });
  document.addEventListener("click", (event) => {
    if (!picker.hidden && !event.target.closest?.(".assistant-picker, .plus-menu")) {
      picker.hidden = true;
    }
  });
  fetch("/chat/assistants", { credentials: "same-origin" })
    .then((response) => (response.ok ? response.json() : null))
    .then((data) => {
      assistants = Array.isArray(data?.items) ? data.items : [];
    })
    .catch(() => {});

  // ---- "/" prompts --------------------------------------------------------
  const PROMPTS = [
    { name: "обобщи", label: "Обобщи", template: "Обобщи накратко в 5 точки:\n\n" },
    { name: "преведи", label: "Преведи на английски", template: "Преведи на английски:\n\n" },
    { name: "имейл", label: "Напиши имейл", template: "Напиши кратък и учтив имейл до … относно …" },
    { name: "обясни", label: "Обясни просто", template: "Обясни просто, като на човек без опит: " },
    { name: "правопис", label: "Поправи правописа", template: "Поправи правописа и пунктуацията, без да сменяш смисъла:\n\n" },
    { name: "план", label: "План по стъпки", template: "Направи план по стъпки за: " },
    { name: "идеи", label: "10 идеи", template: "Дай 10 различни идеи за: " },
    { name: "плюсове", label: "Плюсове и минуси", template: "Сравни плюсовете и минусите на: " },
  ];
  const menu = document.createElement("div");
  menu.className = "slash-menu";
  menu.hidden = true;
  menu.setAttribute("role", "listbox");
  composer.prepend(menu);
  let matches = [];
  let active = 0;

  const choose = (prompt) => {
    input.value = text(prompt.template);
    menu.hidden = true;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  };
  const render = () => {
    menu.replaceChildren(
      ...matches.map((prompt, index) => {
        const item = document.createElement("button");
        item.type = "button";
        item.setAttribute("role", "option");
        item.setAttribute("aria-selected", String(index === active));
        item.innerHTML = `<code></code><span></span>`;
        item.querySelector("code").textContent = `/${prompt.name}`;
        item.querySelector("span").textContent = text(prompt.label);
        item.addEventListener("mousedown", (event) => {
          event.preventDefault();
          choose(prompt);
        });
        return item;
      }),
    );
  };
  input.addEventListener("input", () => {
    const value = input.value;
    const query = /^\/([^\s]*)$/u.exec(value)?.[1]?.toLowerCase();
    if (query === undefined) {
      menu.hidden = true;
      return;
    }
    matches = PROMPTS.filter(
      (prompt) => prompt.name.startsWith(query) || prompt.label.toLowerCase().includes(query),
    );
    active = 0;
    menu.hidden = !matches.length;
    render();
  });
  // Capture phase: Enter picks a prompt instead of sending "/…".
  input.addEventListener(
    "keydown",
    (event) => {
      if (menu.hidden) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        active = (active + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length;
        render();
      } else if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        event.stopImmediatePropagation();
        choose(matches[active]);
      } else if (event.key === "Escape") {
        menu.hidden = true;
      }
    },
    true,
  );
  input.addEventListener("blur", () =>
    setTimeout(() => {
      // Focus may be back in the box by now (after picking from the "+" menu).
      if (document.activeElement !== input) menu.hidden = true;
    }, 150),
  );
})();
