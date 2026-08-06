const commandBar = document.querySelector(".mobile-command-bar");
const composer = document.querySelector(".composer-wrap");
const chatMessages = document.getElementById("chatMessages");
const root = document.documentElement;
const mobileLayout = globalThis.matchMedia?.("(max-width: 900px)");

function updateMobileOccupiedHeight() {
  if (!mobileLayout?.matches || !composer || !commandBar) {
    root.style.removeProperty("--sx-mobile-occupied-height");
    return;
  }

  const distanceFromBottom = chatMessages
    ? chatMessages.scrollHeight -
      chatMessages.clientHeight -
      chatMessages.scrollTop
    : Number.POSITIVE_INFINITY;
  const composerRect = composer.getBoundingClientRect();
  const commandBarRect = commandBar.getBoundingClientRect();
  const viewportBottom =
    globalThis.visualViewport?.offsetTop + globalThis.visualViewport?.height ||
    globalThis.innerHeight;
  const occupiedHeight = Math.max(
    composerRect.height + commandBarRect.height,
    viewportBottom - Math.min(composerRect.top, commandBarRect.top),
  );
  root.style.setProperty(
    "--sx-mobile-occupied-height",
    `${Math.ceil(occupiedHeight + 20)}px`,
  );

  if (chatMessages && distanceFromBottom <= 80) {
    const keepLastAnswerVisible = () => {
      chatMessages.scrollTop = chatMessages.scrollHeight;
    };
    if (typeof globalThis.requestAnimationFrame === "function") {
      globalThis.requestAnimationFrame(keepLastAnswerVisible);
    } else {
      keepLastAnswerVisible();
    }
  }
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
    const isActive = button.dataset.command === command;
    button.classList.toggle("active", isActive);
    if (isActive) {
      button.setAttribute("aria-current", "page");
    } else {
      button.removeAttribute("aria-current");
    }
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
  } else if (command === "connections") {
    forwardClick("workCenterBtn", "connections");
  } else if (command === "status") {
    forwardClick("profileStatusBtn", "status");
  }
});

document.addEventListener("synchron:data-drawer-closed", () => {
  activateCommand("chat");
});

document.addEventListener("synchron:status-closed", () => {
  activateCommand("chat");
});

activateCommand("chat");
