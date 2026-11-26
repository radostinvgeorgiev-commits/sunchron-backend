(() => {
  // Assistants (like GPTs in ChatGPT or bots in Poe) and "/" prompts (like
  // TypingMind and Open WebUI). Both only shape the request; the server
  // checks the assistant id against its own list.
  const $ = (id) => document.getElementById(id);
  const text = (value) => globalThis.AiCoreLocale?.text?.(value) ?? value;
  const input = $("chatInput");
  const composer = input?.closest(".composer-wrap");
  if (!input || !composer) return;

  // ---- The person's own assistants and prompts --------------------------
  let library = { assistants: [], prompts: [] };
  const saveLibrary = async () => {
    const response = await fetch("/api/library", {
      method: "PUT",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(library),
    });
    if (response.ok) {
      const data = await response.json();
      library = { assistants: data.assistants || [], prompts: data.prompts || [] };
    }
    return response.ok;
  };
  fetch("/api/library", { credentials: "same-origin" })
    .then((response) => (response.ok ? response.json() : null))
    .then((data) => {
      if (data) library = { assistants: data.assistants || [], prompts: data.prompts || [] };
    })
    .catch(() => {});

  // A small form above the message box: a name and a text.
  const form = document.createElement("form");
  form.className = "library-form";
  form.hidden = true;
  form.innerHTML = `<strong></strong>
    <input type="text" maxlength="40" required />
    <textarea rows="4" required></textarea>
    <div><button type="button" class="library-cancel"></button><button type="submit" class="primary"></button></div>`;
  form.querySelector(".library-cancel").textContent = text("Откажи");
  form.querySelector(".primary").textContent = text("Запази");
  composer.prepend(form);
  let formDone = null;
  const openForm = ({ title, namePlaceholder, textPlaceholder, maxLength, value = "" }, done) => {
    form.querySelector("strong").textContent = title;
    const [name] = form.querySelectorAll("input");
    const body = form.querySelector("textarea");
    name.value = "";
    name.placeholder = namePlaceholder;
    body.value = value;
    body.placeholder = textPlaceholder;
    body.maxLength = maxLength;
    formDone = done;
    form.hidden = false;
    name.focus();
  };
  form.querySelector(".library-cancel").addEventListener("click", () => (form.hidden = true));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = form.querySelector("input").value.trim();
    const body = form.querySelector("textarea").value.trim();
    if (!name || !body) return;
    form.hidden = true;
    await formDone?.(name, body);
  });

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
    const own = library.assistants.map((assistant) => ({
      id: `custom:${assistant.id}`,
      rawId: assistant.id,
      label: assistant.name,
      hint: assistant.instruction.slice(0, 60),
      icon: "fa-user-pen",
      own: true,
    }));
    const add = document.createElement("button");
    add.type = "button";
    add.className = "library-add";
    add.innerHTML = `<i class="fa-solid fa-plus" aria-hidden="true"></i><span><strong></strong><small></small></span>`;
    add.querySelector("strong").textContent = text("Нов мой асистент");
    add.querySelector("small").textContent = text("Име и указания как да отговаря");
    add.addEventListener("click", () => {
      picker.hidden = true;
      openForm(
        {
          title: text("Нов асистент"),
          namePlaceholder: text("Име, например „Моят счетоводител“"),
          textPlaceholder: text("Как да отговаря: роля, стил, какво да внимава"),
          maxLength: 1500,
        },
        async (name, instruction) => {
          library.assistants = [...library.assistants, { name, instruction }];
          if (await saveLibrary()) {
            const saved = library.assistants.at(-1);
            setAssistant({ id: `custom:${saved.id}`, label: saved.name, icon: "fa-user-pen" });
          }
        },
      );
    });
    picker.replaceChildren(
      ...[...own, ...assistants].map((assistant) => {
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
        if (assistant.own) {
          const remove = document.createElement("span");
          remove.className = "library-remove";
          remove.setAttribute("role", "button");
          remove.setAttribute("aria-label", text("Изтрий"));
          remove.textContent = "✕";
          remove.addEventListener("click", async (event) => {
            event.stopPropagation();
            library.assistants = library.assistants.filter(({ id }) => id !== assistant.rawId);
            if (current?.id === assistant.id) setAssistant(null);
            await saveLibrary();
            renderPicker();
          });
          item.appendChild(remove);
        }
        return item;
      }),
      add,
    );
  };
  document.addEventListener("aicore:pick-assistant", () => {
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
    if (prompt.save) {
      menu.hidden = true;
      input.value = "";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      openForm(
        {
          title: text("Нова подсказка"),
          namePlaceholder: text("Кратко име, например „оферта“"),
          textPlaceholder: text("Текстът, който да се попълва в полето"),
          maxLength: 1000,
        },
        async (name, template) => {
          library.prompts = [...library.prompts, { name, template }];
          await saveLibrary();
          input.focus();
        },
      );
      return;
    }
    input.value = prompt.ownId ? prompt.template : text(prompt.template);
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
        if (prompt.ownId) {
          const remove = document.createElement("span");
          remove.className = "library-remove";
          remove.setAttribute("role", "button");
          remove.setAttribute("aria-label", text("Изтрий"));
          remove.textContent = "✕";
          remove.addEventListener("mousedown", async (event) => {
            event.preventDefault();
            event.stopPropagation();
            library.prompts = library.prompts.filter(({ id }) => id !== prompt.ownId);
            await saveLibrary();
            input.dispatchEvent(new Event("input", { bubbles: true }));
          });
          item.appendChild(remove);
        }
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
    const own = library.prompts.map((prompt) => ({
      name: prompt.name.toLowerCase().replace(/\s+/gu, "-"),
      label: prompt.name,
      template: prompt.template,
      ownId: prompt.id,
    }));
    matches = [...own, ...PROMPTS].filter(
      (prompt) => prompt.name.startsWith(query) || prompt.label.toLowerCase().includes(query),
    );
    if ("запази".startsWith(query) || !query) {
      matches.push({ name: "запази", label: text("Запази нова моя подсказка"), save: true });
    }
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
