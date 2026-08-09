(() => {
  const STORAGE_KEY = "synchron.ui.fontScale";
  const DEFAULT_MODE = "standard";
  const MODE_ORDER = Object.freeze(["standard", "large", "max", "ultra"]);
  const MODES = Object.freeze({
    standard: {
      label: "Обикновен · 16 px",
      pixels: 16,
    },
    large: {
      label: "Едър · 32 px",
      pixels: 32,
    },
    max: {
      label: "Много едър · 48 px",
      pixels: 48,
    },
    ultra: {
      label: "Огромен · 60 px",
      pixels: 60,
    },
  });

  const root = document.documentElement;
  const decreaseButton = document.getElementById("fontSizeDecreaseBtn");
  const increaseButton = document.getElementById("fontSizeIncreaseBtn");
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
    const modeIndex = MODE_ORDER.indexOf(safeMode);
    root.dataset.fontLevel = safeMode;
    root.dataset.fontScale = safeMode === "standard" ? "standard" : "max";

    if (decreaseButton) {
      decreaseButton.disabled = modeIndex === 0;
      decreaseButton.setAttribute("aria-disabled", String(modeIndex === 0));
    }
    if (increaseButton) {
      increaseButton.disabled = modeIndex === MODE_ORDER.length - 1;
      increaseButton.setAttribute(
        "aria-disabled",
        String(modeIndex === MODE_ORDER.length - 1),
      );
    }
    if (label) label.textContent = settings.label;
    if (persist) storeMode(safeMode);
    return safeMode;
  }

  function stepMode(direction) {
    const currentIndex = MODE_ORDER.indexOf(currentMode);
    const nextIndex = Math.min(
      MODE_ORDER.length - 1,
      Math.max(0, currentIndex + direction),
    );
    currentMode = applyMode(MODE_ORDER[nextIndex]);
    return currentMode;
  }

  let currentMode = applyMode(readStoredMode());
  decreaseButton?.addEventListener("click", () => stepMode(-1));
  increaseButton?.addEventListener("click", () => stepMode(1));

  globalThis.SynchronAccessibility = Object.freeze({
    applyMode: (mode, options) => {
      currentMode = applyMode(mode, options);
      return currentMode;
    },
    getMode: () => currentMode,
    increase: () => stepMode(1),
    decrease: () => stepMode(-1),
  });
})();
