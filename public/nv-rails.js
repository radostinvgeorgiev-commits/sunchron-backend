// The two side rails after sign-in, as in modern AI apps: a button in each
// top corner opens or folds its menu. Folded, a menu is one row of icons,
// so the conversation keeps almost all of the screen.
(() => {
  const shell = document.getElementById("appShell");
  if (!shell) return;
  const leftButton = document.getElementById("sidebarRailBtn");
  const rail = document.getElementById("rightRail");
  const railToggle = document.getElementById("rightRailToggle");
  const phoneButton = document.getElementById("rightRailBtn");
  const phone = window.matchMedia("(max-width: 760px)");
  const say = (value) => globalThis.NovariumLocale?.text?.(value) ?? value;
  const remember = (key, value) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Private window: the choice lasts until the page closes.
    }
  };
  const recall = (key) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  };

  // Every button in the folded left menu shows its name on hover.
  const nameButtons = () => {
    for (const item of document.querySelectorAll("#sidebar button, #sidebar a, #sidebar summary")) {
      if (item.title) continue;
      const name = item.textContent.replace(/\s+/gu, " ").trim();
      if (name) item.title = name;
    }
  };

  const setLeft = (folded) => {
    shell.classList.toggle("nv-left-folded", folded);
    if (leftButton) {
      leftButton.setAttribute("aria-expanded", String(!folded));
      const label = say(folded ? "Отвори менюто" : "Свий менюто");
      leftButton.setAttribute("aria-label", label);
      leftButton.title = label;
    }
    if (folded) nameButtons();
    remember("nv-left-folded", folded ? "1" : "0");
  };
  const setRight = (open) => {
    shell.classList.toggle("nv-right-open", open);
    railToggle?.setAttribute("aria-expanded", String(open));
    phoneButton?.setAttribute("aria-expanded", String(open));
    if (!phone.matches) remember("nv-right-open", open ? "1" : "0");
  };

  leftButton?.addEventListener("click", () => setLeft(!shell.classList.contains("nv-left-folded")));
  railToggle?.addEventListener("click", () => setRight(!shell.classList.contains("nv-right-open")));
  phoneButton?.addEventListener("click", () => setRight(!shell.classList.contains("nv-right-open")));

  // The quick buttons do what the same buttons in the menus do.
  rail?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-rail-for]");
    if (!button) return;
    document.getElementById(button.dataset.railFor)?.click();
    if (phone.matches) setRight(false);
  });
  // On a phone the open rail closes with a tap outside it or Escape.
  document.addEventListener("click", (event) => {
    if (!phone.matches || !shell.classList.contains("nv-right-open")) return;
    if (rail?.contains(event.target) || phoneButton?.contains(event.target)) return;
    setRight(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && phone.matches) setRight(false);
  });

  setLeft(recall("nv-left-folded") === "1");
  setRight(!phone.matches && recall("nv-right-open") === "1");
})();
