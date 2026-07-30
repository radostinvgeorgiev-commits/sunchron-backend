const commandBar = document.querySelector(".mobile-command-bar");
const composer = document.querySelector(".composer-wrap");
const root = document.documentElement;
const mobileLayout = globalThis.matchMedia?.("(max-width: 900px)");

function updateMobileOccupiedHeight() {
  if (!mobileLayout?.matches || !composer || !commandBar) {
    root.style.removeProperty("--sx-mobile-occupied-height");
    return;
  }

  const occupiedHeight =
    composer.getBoundingClientRect().height +
    commandBar.getBoundingClientRect().height;
  root.style.setProperty(
    "--sx-mobile-occupied-height",
    `${Math.ceil(occupiedHeight)}px`,
  );
}

function scheduleMobileLayoutUpdate() {
  if (typeof globalThis.requestAnimationFrame === "function") {
    globalThis.requestAnimationFrame(updateMobileOccupiedHeight);
    return;
  }
  updateMobileOccupiedHeight();
}

if (typeof globalThis.ResizeObserver === "function") {
  const mobileChromeObserver = new globalThis.ResizeObserver(
    scheduleMobileLayoutUpdate,
  );
  if (composer) mobileChromeObserver.observe(composer);
  if (commandBar) mobileChromeObserver.observe(commandBar);
}

mobileLayout?.addEventListener?.("change", scheduleMobileLayoutUpdate);
globalThis.visualViewport?.addEventListener?.(
  "resize",
  scheduleMobileLayoutUpdate,
);
globalThis.addEventListener?.("orientationchange", scheduleMobileLayoutUpdate);
scheduleMobileLayoutUpdate();

function activateCommand(command) {
  if (!commandBar) return;
  for (const button of commandBar.querySelectorAll("button")) {
    button.classList.toggle("active", button.dataset.command === command);
  }
}

function forwardClick(targetId, command) {
  const target = document.getElementById(targetId);
  if (!target) return;
  target.click();
  activateCommand(command);
}

commandBar?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-command]");
  if (!button) return;

  const command = button.dataset.command;
  if (command === "chat") {
    document.getElementById("closeDataDrawerBtn")?.click();
    document.getElementById("closeContextBtn")?.click();
    document.getElementById("chatInput")?.focus();
    activateCommand("chat");
  } else if (command === "memory") {
    forwardClick("memoryBtn", "memory");
  } else if (command === "tasks") {
    forwardClick("focusBtn", "tasks");
  } else if (command === "connections") {
    forwardClick("toolsBtn", "connections");
  }
});

document.getElementById("closeDataDrawerBtn")?.addEventListener("click", () => {
  activateCommand("chat");
});

activateCommand("chat");
