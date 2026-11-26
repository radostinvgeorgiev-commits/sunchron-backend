(() => {
  const title = document.getElementById("statusTitle");
  const meta = document.getElementById("statusMeta");
  const list = document.getElementById("statusList");
  const TITLES = {
    ok: "Всичко работи",
    partial: "Работи, но един от моделите не отговаря",
    down: "Има проблем с услугата",
  };
  const row = (name, working) => {
    const item = document.createElement("li");
    item.className = working ? "ok" : "bad";
    const label = document.createElement("span");
    label.textContent = name;
    const state = document.createElement("strong");
    state.textContent = working ? "Работи" : "Не отговаря";
    item.append(label, state);
    return item;
  };
  async function refresh() {
    try {
      const response = await fetch("/health/status", { cache: "no-store" });
      if (!response.ok) throw new Error("status");
      const data = await response.json();
      title.textContent = TITLES[data.status] || TITLES.down;
      document.body.dataset.status = data.status;
      meta.textContent = `Проверено в ${new Date(data.checkedAt).toLocaleTimeString("bg-BG", { hour: "2-digit", minute: "2-digit" })}`;
      list.replaceChildren(row("Сайтът", data.site), ...data.models.map((m) => row(m.name, m.working)));
    } catch {
      title.textContent = TITLES.down;
      document.body.dataset.status = "down";
      meta.textContent = "Сайтът не отговори на проверката.";
      list.replaceChildren(row("Сайтът", false));
    }
  }
  refresh();
  setInterval(refresh, 60_000);
})();
