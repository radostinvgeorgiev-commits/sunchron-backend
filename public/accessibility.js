(() => {
  const STORAGE_KEY = "synchron.ui.fontScale";
  const DEFAULT_MODE = "max";
  const MODES = Object.freeze({
    max: {
      label: "Много едър шрифт",
      title: "Текстът е много едър. Натисни за стандартен размер.",
      pressed: true,
      next: "standard",
    },
    standard: {
      label: "Стандартен шрифт",
      title: "Текстът е стандартен. Натисни за много едър размер.",
      pressed: false,
      next: "max",
    },
  });

  const root = document.documentElement;
  const button = document.getElementById("fontSizeBtn");
  const label = document.getElementById("fontSizeLabel");

  function readStoredMode() {
    try {
      const stored = globalThis.localStorage?.getItem(STORAGE_KEY);
      return MODES[stored] ? stored : DEFAULT_MODE;
    } catch {
      return DEFAULT_MODE;
    }
  }

  function storeMode(mode) {
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, mode);
    } catch {
      // The large-text mode still works when storage is unavailable.
    }
  }

  function applyMode(mode, { persist = true } = {}) {
    const safeMode = MODES[mode] ? mode : DEFAULT_MODE;
    const settings = MODES[safeMode];
    root.dataset.fontScale = safeMode;

    if (button) {
      button.setAttribute("aria-pressed", String(settings.pressed));
      button.title = settings.title;
    }
    if (label) label.textContent = settings.label;
    if (persist) storeMode(safeMode);
    return safeMode;
  }

  let currentMode = applyMode(readStoredMode());
  button?.addEventListener("click", () => {
    currentMode = applyMode(MODES[currentMode].next);
  });

  globalThis.SynchronAccessibility = Object.freeze({
    applyMode,
    getMode: () => currentMode,
  });
})();
