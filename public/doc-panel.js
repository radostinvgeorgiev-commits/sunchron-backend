(() => {
  // "Отвори отстрани": an answer opens in a side panel, like Canvas in ChatGPT
  // or Artifacts in Claude — to read, copy, download, print as PDF, and to see
  // number tables as a bar chart.
  const text = (value) => globalThis.AiCoreLocale?.text?.(value) ?? value;
  const panel = document.createElement("aside");
  panel.className = "doc-panel";
  panel.hidden = true;
  panel.setAttribute("aria-label", text("Документ"));
  panel.innerHTML = `
    <header class="doc-panel-head">
      <strong></strong>
      <div class="doc-panel-tools">
        <button type="button" data-doc="copy"></button>
        <button type="button" data-doc="download"></button>
        <button type="button" data-doc="print"></button>
        <button type="button" data-doc="close" aria-label="${text("Затвори")}">✕</button>
      </div>
    </header>
    <div class="doc-panel-body"></div>
    <p class="doc-panel-status" role="status"></p>`;
  document.body.appendChild(panel);
  const $ = (selector) => panel.querySelector(selector);
  $("strong").textContent = text("Документ");
  $('[data-doc="copy"]').textContent = text("Копирай");
  $('[data-doc="download"]').textContent = text("Изтегли");
  $('[data-doc="print"]').textContent = text("PDF / печат");
  let raw = "";

  // "1 234,5 лв." → 1234.5; anything that is not a number → NaN.
  const toNumber = (value) => {
    const cleaned = String(value || "").replace(/[\s ]/gu, "").replace(/[€$%]|лв\.?|eur|bgn/giu, "");
    if (!/^-?[\d.,]+$/u.test(cleaned)) return Number.NaN;
    const normal = /,\d{1,2}$/u.test(cleaned) ? cleaned.replace(/\./gu, "").replace(",", ".") : cleaned.replace(/,/gu, "");
    return Number(normal);
  };
  function chartFor(table) {
    const rows = [...table.querySelectorAll("tbody tr")].map((row) => [...row.cells].map((cell) => cell.textContent.trim()));
    const heads = [...table.querySelectorAll("thead th")].map((cell) => cell.textContent.trim());
    if (rows.length < 2 || !rows[0]?.length) return null;
    const column = rows[0].findIndex((_, index) => index > 0 && rows.every((row) => Number.isFinite(toNumber(row[index]))));
    if (column < 1) return null;
    const values = rows.map((row) => ({ label: row[0], value: toNumber(row[column]) })).slice(0, 20);
    const max = Math.max(...values.map(({ value }) => Math.abs(value)), 1);
    const svgNs = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNs, "svg");
    const rowHeight = 28;
    svg.setAttribute("viewBox", `0 0 600 ${values.length * rowHeight + 30}`);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", `${text("Графика")}: ${heads[column] || ""}`);
    svg.classList.add("doc-chart");
    const title = document.createElementNS(svgNs, "text");
    title.setAttribute("x", "0");
    title.setAttribute("y", "16");
    title.setAttribute("class", "doc-chart-title");
    title.textContent = heads[column] || text("Стойност");
    svg.append(title);
    values.forEach(({ label, value }, index) => {
      const y = 28 + index * rowHeight;
      const name = document.createElementNS(svgNs, "text");
      name.setAttribute("x", "0");
      name.setAttribute("y", String(y + 15));
      name.textContent = label.length > 22 ? `${label.slice(0, 21)}…` : label;
      const bar = document.createElementNS(svgNs, "rect");
      bar.setAttribute("x", "170");
      bar.setAttribute("y", String(y + 3));
      bar.setAttribute("height", "16");
      bar.setAttribute("rx", "4");
      bar.setAttribute("width", String(Math.max(2, (Math.abs(value) / max) * 330)));
      const amount = document.createElementNS(svgNs, "text");
      amount.setAttribute("x", String(176 + (Math.abs(value) / max) * 330));
      amount.setAttribute("y", String(y + 15));
      amount.textContent = value.toLocaleString("bg-BG");
      svg.append(name, bar, amount);
    });
    return svg;
  }
  function addChartButtons() {
    for (const table of panel.querySelectorAll(".doc-panel-body table")) {
      if (!chartFor(table)) continue;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "doc-chart-button";
      button.textContent = text("Покажи като графика");
      button.addEventListener("click", () => {
        button.replaceWith(chartFor(table));
      });
      table.after(button);
    }
  }
  function open(value) {
    raw = value;
    const body = $(".doc-panel-body");
    if (globalThis.SynchronChat?.renderMarkdown) globalThis.SynchronChat.renderMarkdown(body, value);
    else body.textContent = value;
    $(".doc-panel-status").textContent = "";
    addChartButtons();
    panel.hidden = false;
    document.body.classList.add("doc-panel-open");
  }
  const close = () => {
    panel.hidden = true;
    document.body.classList.remove("doc-panel-open");
  };

  document.addEventListener("click", (event) => {
    const button = event.target.closest('button[data-action="open-panel"]');
    if (!button) return;
    const message = button.closest(".assistant-turn")?.querySelector(".message.agent");
    const value = message?.dataset.rawText || message?.innerText || "";
    if (value) open(value);
  });
  panel.addEventListener("click", async (event) => {
    const action = event.target.closest("[data-doc]")?.dataset.doc;
    if (action === "close") close();
    if (action === "copy") {
      try {
        await navigator.clipboard.writeText(raw);
        $(".doc-panel-status").textContent = text("Копирано.");
      } catch {
        $(".doc-panel-status").textContent = text("Копирането не е позволено в този браузър.");
      }
    }
    if (action === "download") {
      const link = document.createElement("a");
      link.href = URL.createObjectURL(new Blob([raw], { type: "text/markdown;charset=utf-8" }));
      link.download = "aicore-dokument.md";
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    }
    if (action === "print") {
      document.body.classList.add("doc-panel-printing");
      globalThis.addEventListener("afterprint", () => document.body.classList.remove("doc-panel-printing"), { once: true });
      globalThis.print();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !panel.hidden) close();
  });
})();
