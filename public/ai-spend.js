(() => {
  // Owner-only ring that fills with this month's estimated AI spend against
  // the limit Радко sets. Hidden for anyone the API refuses (non-owners).
  const REFRESH_MS = 30_000;
  const RADIUS = 15;
  const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
  let root = null;
  let timer = null;

  const money = (value) =>
    `$${(Number(value) || 0).toFixed(Number(value) >= 1 ? 2 : 3)}`;

  function build() {
    const anchor = document.querySelector(".chat-toolbar .status-indicator");
    if (!anchor || document.getElementById("aiSpendRing")) return null;
    const details = document.createElement("details");
    details.id = "aiSpendRing";
    details.className = "ai-spend";
    details.hidden = true;
    details.innerHTML = `
      <summary aria-label="Разход за AI този месец" title="Разход за AI този месец">
        <svg viewBox="0 0 36 36" width="36" height="36" aria-hidden="true">
          <circle class="ai-spend-track" cx="18" cy="18" r="${RADIUS}" />
          <circle class="ai-spend-fill" cx="18" cy="18" r="${RADIUS}"
            stroke-dasharray="${CIRCUMFERENCE}" stroke-dashoffset="${CIRCUMFERENCE}"
            transform="rotate(-90 18 18)" />
        </svg>
        <span class="ai-spend-percent">0%</span>
      </summary>
      <div class="ai-spend-panel">
        <strong class="ai-spend-total"></strong>
        <p class="ai-spend-note">Оценка по токени и цените на моделите. Точната сметка е в конзолите на доставчиците.</p>
        <ul class="ai-spend-models"></ul>
        <strong class="ai-ratings-title">Оценки този месец</strong>
        <ul class="ai-ratings"></ul>
        <form class="ai-spend-limit">
          <label for="aiSpendLimit">Месечен лимит ($)</label>
          <input id="aiSpendLimit" type="number" min="0.01" step="0.01" inputmode="decimal" />
          <button type="submit">Запази</button>
        </form>
      </div>`;
    anchor.before(details);
    details.querySelector("form").addEventListener("submit", saveLimit);
    return details;
  }

  function render(data) {
    if (!root) return;
    root.hidden = false;
    const percent = Math.max(0, Math.min(100, Number(data.percent) || 0));
    const fill = root.querySelector(".ai-spend-fill");
    fill.setAttribute("stroke-dashoffset", String(CIRCUMFERENCE * (1 - percent / 100)));
    root.dataset.level = percent >= 90 ? "high" : percent >= 70 ? "mid" : "low";
    root.querySelector(".ai-spend-percent").textContent = `${Math.round(percent)}%`;
    root.querySelector(".ai-spend-total").textContent =
      `${money(data.totalUsd)} от ${money(data.limitUsd)} · ${data.month}`;
    const list = root.querySelector(".ai-spend-models");
    list.replaceChildren(
      ...(data.models?.length ? data.models : [{ model: "Още няма разход", empty: true }]).map((m) => {
        const item = document.createElement("li");
        item.textContent = m.empty
          ? m.model
          : `${m.model} — ${m.priced === false ? "без цена" : money(m.usd)} · ${m.calls} заявки`;
        return item;
      }),
    );
    const input = root.querySelector("#aiSpendLimit");
    if (document.activeElement !== input) input.value = String(data.limitUsd);
  }

  // 👍/👎 and blind-comparison results per model, for the owner.
  async function refreshRatings() {
    const list = root?.querySelector(".ai-ratings");
    if (!list) return;
    try {
      const response = await fetch("/api/feedback/summary", { credentials: "same-origin" });
      if (!response.ok) return;
      const data = await response.json();
      const rows = data.models?.length ? data.models : [{ empty: true }];
      list.replaceChildren(
        ...rows.map((m) => {
          const item = document.createElement("li");
          item.textContent = m.empty
            ? "Още няма оценки"
            : `${m.model.replace(":", " · ")} — 👍 ${m.up || 0} · 👎 ${m.down || 0} · сравнения: ${m.win || 0} победи, ${m.loss || 0} загуби, ${m.tie || 0} равни`;
          return item;
        }),
      );
    } catch {
      // keep the last list
    }
  }

  async function refresh() {
    if (!root) root = build();
    if (!root) return;
    try {
      const response = await fetch("/api/ai-spend", { credentials: "same-origin" });
      if (!response.ok) {
        root.hidden = true;
        if (response.status === 401 || response.status === 403) stop();
        return;
      }
      render(await response.json());
      void refreshRatings();
    } catch {
      // keep the last value; try again on the next tick
    }
  }

  async function saveLimit(event) {
    event.preventDefault();
    const input = root.querySelector("#aiSpendLimit");
    const response = await fetch("/api/ai-spend/limit", {
      method: "PUT",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limitUsd: Number(input.value) }),
    });
    const data = await response.json().catch(() => ({}));
    if (response.ok) render(data);
    else input.setCustomValidity(data.error || "Лимитът не беше записан."), input.reportValidity(), input.setCustomValidity("");
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

  globalThis.SynchronAiSpend = { refresh, start };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && timer) void refresh();
  });
})();
