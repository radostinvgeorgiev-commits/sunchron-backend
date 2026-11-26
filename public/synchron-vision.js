const composer = document.querySelector(".composer-wrap");
const chatMessages = document.getElementById("chatMessages");
const root = document.documentElement;
const mobileLayout = globalThis.matchMedia?.("(max-width: 900px)");

function updateMobileOccupiedHeight() {
  if (!mobileLayout?.matches || !composer) {
    root.style.removeProperty("--sx-mobile-occupied-height");
    return;
  }

  const distanceFromBottom = chatMessages
    ? chatMessages.scrollHeight -
      chatMessages.clientHeight -
      chatMessages.scrollTop
    : Number.POSITIVE_INFINITY;
  const composerRect = composer.getBoundingClientRect();
  const viewportBottom =
    globalThis.visualViewport?.offsetTop + globalThis.visualViewport?.height ||
    globalThis.innerHeight;
  const occupiedHeight = Math.max(
    composerRect.height,
    viewportBottom - composerRect.top,
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
}

mobileLayout?.addEventListener?.("change", scheduleMobileLayoutUpdate);
globalThis.visualViewport?.addEventListener?.(
  "resize",
  scheduleMobileLayoutUpdate,
);
globalThis.addEventListener?.("orientationchange", scheduleMobileLayoutUpdate);
scheduleMobileLayoutUpdate();
