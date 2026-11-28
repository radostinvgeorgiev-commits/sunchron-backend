(() => {
  // A ring for every member that fills as this month's AI units are spent,
  // so people always see how much is left before it runs out. The owner has
  // no allowance and sees the spend ring instead (ai-spend.js).
  const REFRESH_MS = 60_000;
  const RADIUS = 15;
  const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
  const text = (value, values) =>
    globalThis.NovariumLocale?.text?.(value, values) ??
    String(value).replace(/\{(\w+)\}/g, (_, key) => values?.[key] ?? "");
  let root = null;
  let timer = null;

  function build() {
    const anchor = document.querySelector(".chat-toolbar .status-indicator");
    if (!anchor || document.getElementById("unitsRing")) return null;
    const details = document.createElement("details");
    details.id = "unitsRing";
    details.className = "ai-spend units-ring";
    details.hidden = true;
    const label = text("AI единици този месец");
    details.innerHTML = `
      <summary aria-label="${label}" title="${label}">
        <svg viewBox="0 0 36 36" width="36" height="36" aria-hidden="true">
          <circle class="ai-spend-track" cx="18" cy="18" r="${RADIUS}" />
          <circle class="ai-spend-fill" cx="18" cy="18" r="${RADIUS}"
            stroke-dasharray="${CIRCUMFERENCE}" stroke-dashoffset="${CIRCUMFERENCE}"
            transform="rotate(-90 18 18)" />
        </svg>
        <span class="ai-spend-percent">0</span>
      </summary>
      <div class="ai-spend-panel">
        <strong class="ai-spend-total"></strong>
        <p class="units-ring-renew"></p>
        <p class="ai-spend-note"></p>
        <a class="units-ring-more" href="/plans"></a>
      </div>`;
    anchor.before(details);
    return details;
  }

  function render(usage) {
    if (!root) return;
    const remaining = Math.max(0, Number(usage.remaining) || 0);
    const total = Math.max(1, Number(usage.allowance) || remaining || 1);
    const used = Math.max(0, total - remaining);
    const percent = Math.min(100, (used / total) * 100);
    root.hidden = false;
    root
      .querySelector(".ai-spend-fill")
      .setAttribute("stroke-dashoffset", String(CIRCUMFERENCE * (1 - percent / 100)));
    root.dataset.level = percent >= 90 ? "high" : percent >= 70 ? "mid" : "low";
    root.querySelector(".ai-spend-percent").textContent = String(remaining);
    root.querySelector(".ai-spend-total").textContent = text(
      "Остават {remaining} от {total} AI единици",
      { remaining, total },
    );
    const renew = root.querySelector(".units-ring-renew");
    const date = new Date(Number(usage.expiresAt));
    renew.textContent = Number.isFinite(date.getTime())
      ? text("Подновяват се на {date}", {
          date: date.toLocaleDateString(globalThis.NovariumLocale?.browserLocale),
        })
      : "";
    root.querySelector(".ai-spend-note").textContent = text(
      "Обикновеният чат е безплатен. Единиците се харчат за по-тежка работа.",
    );
    root.querySelector(".units-ring-more").textContent = text("Още единици");
  }

  async function refresh() {
    if (!root) root = build();
    if (!root) return;
    try {
      const response = await fetch("/api/product/usage", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) {
        root.hidden = true;
        if (response.status === 401 || response.status === 403) stop();
        return;
      }
      const usage = await response.json();
      if (usage.owner) {
        root.hidden = true;
        stop();
        return;
      }
      render(usage);
    } catch {
      // keep the last value; try again on the next tick
    }
  }

  function start() {
    stop();
    void refresh();
    timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, REFRESH_MS);
  }
  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  globalThis.NovariumUnitsRing = { refresh, start };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && timer) void refresh();
  });
  // Starts on sign-in for every account; the owner's account stops it again.
  document.addEventListener("novarium:signed-in", start);
})();
