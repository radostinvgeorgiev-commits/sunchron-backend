// Registers the minimal service worker that makes AI CORE installable
// ("Add to Home Screen"). Failures are silent: the site works without it.
if ("serviceWorker" in navigator) {
  addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
