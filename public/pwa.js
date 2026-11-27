// Registers the minimal service worker that makes NovariumAI installable
// ("Add to Home Screen"). Failures are silent: the site works without it.
if ("serviceWorker" in navigator) {
  addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

// A phone keeps an opened page (and an app on the home screen) in memory for
// days without loading it again, so a person kept seeing an old version after
// an update. When the page comes back to the screen, or every 30 minutes, it
// asks which version is live and reloads itself if it is newer, but never
// while the person is typing or an answer is coming.
(() => {
  let loadedCommit = "";
  let lastCheck = 0;
  const readCommit = () =>
    fetch("/health", { cache: "no-store", credentials: "omit" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => (typeof data?.commit === "string" ? data.commit : ""))
      .catch(() => "");
  const idle = () => {
    const input = document.getElementById("chatInput");
    const send = document.getElementById("sendBtn");
    if (input && input.value.trim()) return false;
    if (send && send.classList.contains("is-stop")) return false;
    if (document.activeElement?.matches?.("input, textarea, [contenteditable]")) {
      const value = document.activeElement.value ?? document.activeElement.textContent;
      if (String(value || "").trim()) return false;
    }
    return true;
  };
  const check = async () => {
    if (document.visibilityState !== "visible" || Date.now() - lastCheck < 60_000) return;
    lastCheck = Date.now();
    const live = await readCommit();
    if (!live || live === "unknown") return;
    if (!loadedCommit) {
      loadedCommit = live;
      return;
    }
    if (live !== loadedCommit && idle()) location.reload();
  };
  readCommit().then((commit) => {
    loadedCommit = commit;
    lastCheck = Date.now();
  });
  document.addEventListener("visibilitychange", check);
  addEventListener("pageshow", (event) => {
    if (event.persisted) check();
  });
  setInterval(check, 30 * 60_000);
})();
