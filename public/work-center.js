(() => {
  const REPOSITORY_URL =
    "https://github.com/radostinvgeorgiev-commits/sunchron-backend";
  const FALLBACK_CONFIG = Object.freeze({
    chatgptWorkUrl: "https://chatgpt.com/",
    digitalOceanUrl: "https://cloud.digitalocean.com/",
    cloudflareUrl: "https://dash.cloudflare.com/",
  });

  const button = document.getElementById("workCenterBtn");
  const drawer = document.getElementById("dataDrawer");
  const backdrop = document.getElementById("drawerBackdrop");
  const title = document.getElementById("dataDrawerTitle");
  const body = document.getElementById("dataDrawerBody");
  const sidebar = document.getElementById("sidebar");
  if (!button || !drawer || !backdrop || !title || !body || !sidebar) return;

  function safeHttpsUrl(value, fallback = null) {
    try {
      const url = new URL(String(value || fallback));
      return url.protocol === "https:" ? url.href : fallback;
    } catch {
      return fallback;
    }
  }

  function addText(parent, tag, text, className) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    element.textContent = text;
    parent.appendChild(element);
    return element;
  }

  function createExternalCard({
    title: cardTitle,
    description,
    url,
    icon,
    featured = false,
  }) {
    const card = document.createElement("a");
    card.className = `work-center-card${featured ? " featured" : ""}`;
    card.href = url;
    card.target = "_blank";
    card.rel = "noopener noreferrer";

    const iconElement = document.createElement("span");
    iconElement.className = "work-center-icon";
    iconElement.innerHTML = `<i class="${icon}" aria-hidden="true"></i>`;
    card.appendChild(iconElement);

    const content = document.createElement("span");
    content.className = "work-center-card-content";
    addText(content, "strong", cardTitle);
    addText(content, "span", description, "work-center-description");
    addText(
      content,
      "span",
      "Външна услуга · Може да изисква вход",
      "work-center-status external",
    );
    card.appendChild(content);

    const arrow = document.createElement("i");
    arrow.className =
      "fa-solid fa-arrow-up-right-from-square work-center-arrow";
    arrow.setAttribute("aria-hidden", "true");
    card.appendChild(arrow);
    return card;
  }

  function createInternalCard({
    title: cardTitle,
    description,
    targetId,
    icon,
  }) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "work-center-card";
    card.dataset.workCenterTarget = targetId;

    const iconElement = document.createElement("span");
    iconElement.className = "work-center-icon";
    iconElement.innerHTML = `<i class="${icon}" aria-hidden="true"></i>`;
    card.appendChild(iconElement);

    const content = document.createElement("span");
    content.className = "work-center-card-content";
    addText(content, "strong", cardTitle);
    addText(content, "span", description, "work-center-description");
    addText(
      content,
      "span",
      "Вградено и работи в SYNCHRON-X",
      "work-center-status internal",
    );
    card.appendChild(content);
    return card;
  }

  function closeWorkCenter() {
    drawer.hidden = true;
    backdrop.hidden = true;
    document.getElementById("chatInput")?.focus();
  }

  function renderWorkCenter(config) {
    const chatgptUrl = safeHttpsUrl(
      config.chatgptWorkUrl,
      FALLBACK_CONFIG.chatgptWorkUrl,
    );
    const digitalOceanUrl = safeHttpsUrl(
      config.digitalOceanUrl,
      FALLBACK_CONFIG.digitalOceanUrl,
    );
    const cloudflareUrl = safeHttpsUrl(
      config.cloudflareUrl,
      FALLBACK_CONFIG.cloudflareUrl,
    );

    body.replaceChildren();
    const intro = document.createElement("div");
    intro.className = "work-center-intro";
    addText(
      intro,
      "p",
      "Отвори работните услуги от едно място. Тези карти са навигация и не дават нови права на агента.",
    );
    body.appendChild(intro);

    const grid = document.createElement("section");
    grid.className = "work-center-grid";
    grid.setAttribute("aria-label", "Услуги на проекта");
    const cards = [
      createExternalCard({
        title: "Отвори ChatGPT",
        description: "Продължи работата в ChatGPT чрез безопасен HTTPS адрес.",
        url: chatgptUrl,
        icon: "fa-solid fa-comment-dots",
        featured: true,
      }),
      createExternalCard({
        title: "GitHub — хранилище",
        description: "Кодът и историята на SYNCHRON-X.",
        url: REPOSITORY_URL,
        icon: "fa-brands fa-github",
      }),
      createExternalCard({
        title: "GitHub — задачи",
        description: "Отворените задачи за проекта.",
        url: `${REPOSITORY_URL}/issues`,
        icon: "fa-solid fa-list-check",
      }),
      createExternalCard({
        title: "GitHub — Pull Requests",
        description: "Промените, които чакат преглед.",
        url: `${REPOSITORY_URL}/pulls`,
        icon: "fa-solid fa-code-pull-request",
      }),
      createExternalCard({
        title: "GitHub Actions / публикуване",
        description: "Тестове, проверки и история на изпълненията.",
        url: `${REPOSITORY_URL}/actions`,
        icon: "fa-solid fa-rocket",
      }),
      createExternalCard({
        title: "DigitalOcean",
        description: "Облачната услуга, която публикува сайта.",
        url: digitalOceanUrl,
        icon: "fa-brands fa-digital-ocean",
      }),
      createExternalCard({
        title: "Cloudflare",
        description: "Домейн, защита и мрежови настройки.",
        url: cloudflareUrl,
        icon: "fa-brands fa-cloudflare",
      }),
      createInternalCard({
        title: "Google Drive",
        description: "Преглед и анализ на разрешени файлове.",
        targetId: "googleDriveBtn",
        icon: "fa-brands fa-google-drive",
      }),
      createInternalCard({
        title: "Gmail",
        description: "Преглед на разрешените имейли само за четене.",
        targetId: "gmailBtn",
        icon: "fa-solid fa-envelope",
      }),
      createInternalCard({
        title: "Google Calendar",
        description: "Преглед на предстоящите събития.",
        targetId: "googleCalendarBtn",
        icon: "fa-solid fa-calendar-days",
      }),
    ];
    cards.forEach((card) => grid.appendChild(card));
    body.appendChild(grid);

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "work-center-close";
    closeButton.dataset.closeWorkCenter = "";
    closeButton.textContent = "Назад към чата";
    body.appendChild(closeButton);
  }

  async function openWorkCenter() {
    title.textContent = "Работен център";
    drawer.hidden = false;
    backdrop.hidden = false;
    sidebar.classList.remove("mobile-visible");
    body.innerHTML =
      '<div class="drawer-state"><i class="fa-solid fa-circle-notch fa-spin"></i> Зареждане…</div>';

    let config = FALLBACK_CONFIG;
    try {
      const response = await fetch("/api/public-config", { cache: "no-store" });
      if (response.ok) config = await response.json();
    } catch {
      config = FALLBACK_CONFIG;
    }
    renderWorkCenter(config || FALLBACK_CONFIG);
  }

  body.addEventListener("click", (event) => {
    if (event.target.closest("[data-close-work-center]")) {
      closeWorkCenter();
      return;
    }
    const internalCard = event.target.closest("[data-work-center-target]");
    if (!internalCard) return;
    document.getElementById(internalCard.dataset.workCenterTarget)?.click();
  });
  button.addEventListener("click", openWorkCenter);

  globalThis.SynchronWorkCenter = Object.freeze({
    openWorkCenter,
    safeHttpsUrl,
  });
})();
