(() => {
  // Interface behaviours borrowed from the big multi-model apps. Each piece
  // reuses the existing buttons, so the original handlers keep working.
  const $ = (id) => document.getElementById(id);
  const text = (value) => globalThis.AiCoreLocale?.text?.(value) ?? value;

  // Phone header: "new chat" next to the menu, like ChatGPT and Claude.
  $("mobileNewChatBtn")?.addEventListener("click", () => $("newChatBtn")?.click());

  // "+" opens a small menu (file, Council) instead of the file picker.
  const attach = $("attachBtn");
  const composer = attach?.closest(".composer-wrap");
  const council = $("councilModeBtn");
  if (attach && composer) {
    const menu = document.createElement("div");
    menu.className = "plus-menu";
    menu.hidden = true;
    menu.setAttribute("role", "menu");
    menu.innerHTML = `
      <button type="button" role="menuitem" data-plus="file">
        <i class="fa-solid fa-paperclip" aria-hidden="true"></i>
        <span>${text("Снимка или PDF")}<small>${text("AI CORE ще го прочете")}</small></span>
      </button>
      <button type="button" role="menuitem" data-plus="council">
        <i class="fa-solid fa-people-group" aria-hidden="true"></i>
        <span>${text("Съвет от модели")}<small>${text("Питай няколко AI и сравни")}</small></span>
      </button>
      <button type="button" role="menuitem" data-plus="knowledge">
        <i class="fa-solid fa-folder-open" aria-hidden="true"></i>
        <span>${text("Моите файлове")}<small>${text("AI търси в тях при всеки въпрос")}</small></span>
      </button>
      <button type="button" role="menuitem" data-plus="compare">
        <i class="fa-solid fa-scale-unbalanced" aria-hidden="true"></i>
        <span>${text("Сляпо сравнение")}<small>${text("Два модела, ти избираш по-добрия")}</small></span>
      </button>
      <button type="button" role="menuitem" data-plus="assistant">
        <i class="fa-solid fa-user-tie" aria-hidden="true"></i>
        <span>${text("Асистент")}<small>${text("Юрист, учител, преводач…")}</small></span>
      </button>`;
    composer.prepend(menu);

    const chip = document.createElement("div");
    chip.className = "council-chip";
    chip.hidden = true;
    chip.innerHTML = `<i class="fa-solid fa-people-group" aria-hidden="true"></i><span></span>
      <button type="button" aria-label="${text("Изключи Съвета")}">✕</button>`;
    composer.prepend(chip);

    const close = () => {
      menu.hidden = true;
      attach.setAttribute("aria-expanded", "false");
    };
    const syncChip = () => {
      const on = council?.getAttribute("aria-pressed") === "true";
      const names = [...document.querySelectorAll('input[name="councilProvider"]:checked')]
        .map((input) => input.parentElement?.textContent.trim())
        .filter(Boolean);
      chip.hidden = !on;
      chip.querySelector("span").textContent = `${text("Съвет")}: ${names.join(", ") || "—"}`;
    };

    // Runs before the original handler, which opened the file picker.
    document.addEventListener(
      "click",
      (event) => {
        if (event.target.closest?.("#attachBtn")) {
          event.preventDefault();
          event.stopPropagation();
          menu.hidden = !menu.hidden;
          attach.setAttribute("aria-expanded", String(!menu.hidden));
          return;
        }
        if (!event.target.closest?.(".plus-menu")) close();
      },
      true,
    );
    menu.addEventListener("click", (event) => {
      const item = event.target.closest("[data-plus]");
      if (!item) return;
      close();
      if (item.dataset.plus === "file") $("imageInput")?.click();
      if (item.dataset.plus === "council") council?.click();
      if (item.dataset.plus === "knowledge") {
        document.dispatchEvent(new CustomEvent("aicore:knowledge-files"));
      }
      if (item.dataset.plus === "compare") {
        document.dispatchEvent(new CustomEvent("aicore:blind-compare"));
      }
      if (item.dataset.plus === "assistant") {
        document.dispatchEvent(new CustomEvent("aicore:pick-assistant"));
      }
      setTimeout(syncChip, 0);
    });
    chip.querySelector("button").addEventListener("click", () => {
      if (council?.getAttribute("aria-pressed") === "true") council.click();
      syncChip();
    });
    document.addEventListener("change", (event) => {
      if (event.target?.name === "councilProvider") syncChip();
    });
    if (council) new MutationObserver(syncChip).observe(council, { attributes: true });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") close();
    });
  }

  // Greeting with the person's name above the suggestions.
  const greeting = $("quickStartGreeting");
  const name = $("profileName");
  const greet = () => {
    if (!greeting) return;
    const first = (name?.textContent || "").trim().split(/\s+/u)[0];
    greeting.textContent =
      first && !/Проверка|AI CORE/u.test(first)
        ? `${text("С какво да започнем")}, ${first}?`
        : text("С какво да започнем?");
  };
  greet();
  if (name) new MutationObserver(greet).observe(name, { childList: true, characterData: true, subtree: true });
})();

(() => {
  // Model picker in the header, like "ChatGPT 5 ▾" or "Claude Sonnet ▾".
  // The choice is remembered on this device and sent with each chat message;
  // Work mode keeps using its agent's model.
  const STORAGE_KEY = "aiCoreChatModel";
  const button = document.getElementById("modelPickerBtn");
  const label = document.getElementById("modelPickerLabel");
  const menu = document.getElementById("modelPickerMenu");
  const text = (value) => globalThis.AiCoreLocale?.text?.(value) ?? value;
  let choices = [];
  let current = "auto";
  try {
    current = localStorage.getItem(STORAGE_KEY) || "auto";
  } catch {
    // storage can be unavailable (private mode); the default is fine
  }
  globalThis.SynchronUi = {
    ...(globalThis.SynchronUi || {}),
    chatModel: () => current,
    chatModels: () => choices.slice(),
  };
  if (!button || !label || !menu) return;

  const render = () => {
    const chosen = choices.find((choice) => choice.id === current) || choices[0];
    label.textContent = chosen
      ? chosen.id === "auto"
        ? text("Автоматичен")
        : chosen.label
      : "AI CORE";
    menu.replaceChildren(
      ...choices.map((choice) => {
        const item = document.createElement("button");
        item.type = "button";
        item.setAttribute("role", "menuitemradio");
        item.setAttribute("aria-checked", String(choice.id === current));
        item.disabled = choice.available === false;
        item.innerHTML = `<span><strong></strong><small></small></span><i class="fa-solid fa-check" aria-hidden="true"></i>`;
        item.querySelector("strong").textContent = text(choice.label);
        item.querySelector("small").textContent =
          choice.available === false ? text("Не е свързан") : text(choice.hint || "");
        item.addEventListener("click", () => {
          current = choice.id;
          try {
            localStorage.setItem(STORAGE_KEY, current);
          } catch {
            // remembered for this visit only
          }
          close();
          render();
        });
        return item;
      }),
    );
  };
  const close = () => {
    menu.hidden = true;
    button.setAttribute("aria-expanded", "false");
  };
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    menu.hidden = !menu.hidden;
    button.setAttribute("aria-expanded", String(!menu.hidden));
  });
  document.addEventListener("click", (event) => {
    if (!menu.contains(event.target)) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });

  fetch("/chat/models", { credentials: "same-origin" })
    .then((response) => (response.ok ? response.json() : null))
    .then((data) => {
      choices = Array.isArray(data?.items) ? data.items : [];
      if (!choices.some((choice) => choice.id === current && choice.available !== false)) current = "auto";
      render();
    })
    .catch(() => render());
})();
