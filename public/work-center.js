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
    status = "Външна услуга · Може да изисква вход",
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
    addText(content, "span", status, "work-center-status external");
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
    featured = false,
    status = "Вградено и работи в SYNCHRON-X",
    statusClass = "internal",
  }) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = `work-center-card${featured ? " featured" : ""}`;
    card.dataset.workCenterTarget = targetId;

    const iconElement = document.createElement("span");
    iconElement.className = "work-center-icon";
    iconElement.innerHTML = `<i class="${icon}" aria-hidden="true"></i>`;
    card.appendChild(iconElement);

    const content = document.createElement("span");
    content.className = "work-center-card-content";
    addText(content, "strong", cardTitle);
    addText(content, "span", description, "work-center-description");
    addText(content, "span", status, `work-center-status ${statusClass}`);
    card.appendChild(content);
    return card;
  }

  function createActionCard({
    title: cardTitle,
    description,
    action,
    icon,
    status,
    statusClass = "warning",
  }) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "work-center-card";
    card.dataset.workCenterAction = action;

    const iconElement = document.createElement("span");
    iconElement.className = "work-center-icon";
    iconElement.innerHTML = `<i class="${icon}" aria-hidden="true"></i>`;
    card.appendChild(iconElement);

    const content = document.createElement("span");
    content.className = "work-center-card-content";
    addText(content, "strong", cardTitle);
    addText(content, "span", description, "work-center-description");
    addText(content, "span", status, `work-center-status ${statusClass}`);
    card.appendChild(content);
    return card;
  }

  function closeWorkCenter() {
    drawer.hidden = true;
    backdrop.hidden = true;
    document.getElementById("chatInput")?.focus();
  }

  function resolveCoreStatus(readiness) {
    if (
      readiness?.status === "ready" &&
      readiness?.checks?.chatAgent?.ready === true &&
      readiness?.checks?.memory?.ready === true
    ) {
      return {
        label: "AI ядро и постоянна памет: свързани",
        className: "internal",
      };
    }
    if (readiness) {
      return {
        label: "AI ядрото или паметта не са напълно готови",
        className: "warning",
      };
    }
    return {
      label: "Статусът на ядрото не е достъпен",
      className: "warning",
    };
  }

  function resolveToolStatus(
    integrations,
    toolId,
    { connected = true, connectionName = "услугата" } = {},
  ) {
    const tool = integrations?.tools?.find((item) => item.id === toolId);
    if (!tool?.configured || !tool?.enabled || !tool?.executable) {
      return {
        label: "Не е конфигуриран",
        className: "warning",
      };
    }
    if (!connected) {
      return {
        label: `Изисква еднократен вход в ${connectionName}`,
        className: "warning",
      };
    }
    return {
      label: toolId === "github-read" ? "GitHub Read: работи" : "Работи",
      className: "internal",
    };
  }

  function renderWorkCenter(
    config,
    readiness = null,
    integrations = null,
    sessions = {},
    testerAuth = null,
  ) {
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
      "Свързаният разговор е вътре в SYNCHRON-X. Външните услуги не получават автоматично достъп до паметта и не дават нови права на агента.",
    );
    body.appendChild(intro);

    const grid = document.createElement("section");
    grid.className = "work-center-grid";
    grid.setAttribute("aria-label", "Услуги на проекта");
    const coreStatus = resolveCoreStatus(readiness);
    const githubReadStatus = resolveToolStatus(integrations, "github-read");
    const digitalOceanStatus = resolveToolStatus(
      integrations,
      "digitalocean-read",
    );
    const cloudflareStatus = resolveToolStatus(integrations, "cloudflare-read");
    const googleDriveStatus = resolveToolStatus(
      integrations,
      "google-drive-read",
      {
        connected: Boolean(sessions.googleConnected),
        connectionName: "Google",
      },
    );
    const gmailStatus = resolveToolStatus(integrations, "gmail-read", {
      connected: Boolean(sessions.googleConnected),
      connectionName: "Google",
    });
    const calendarStatus = resolveToolStatus(
      integrations,
      "google-calendar-read",
      {
        connected: Boolean(sessions.googleConnected),
        connectionName: "Google",
      },
    );
    const cards = [
      createInternalCard({
        title: "SYNCHRON-X — свързан разговор",
        description:
          "Този чат използва AI ядрото и разрешената постоянна памет.",
        targetId: "chat",
        icon: "fa-solid fa-brain",
        featured: true,
        status: coreStatus.label,
        statusClass: coreStatus.className,
      }),
      createExternalCard({
        title: "ChatGPT — отделен разговор",
        description:
          "Отваря ChatGPT, но не му дава автоматичен достъп до паметта на SYNCHRON-X.",
        url: chatgptUrl,
        icon: "fa-solid fa-comment-dots",
        status: "Външна услуга · Без автоматична връзка с паметта",
      }),
      createExternalCard({
        title: "GitHub — хранилище",
        description: "Кодът и историята на SYNCHRON-X.",
        url: REPOSITORY_URL,
        icon: "fa-brands fa-github",
        status: githubReadStatus.label,
      }),
      createInternalCard({
        title: "Дневник на задачите",
        description: "Текущи, чакащи и завършени задачи на едно място.",
        targetId: "focusBtn",
        icon: "fa-solid fa-list-check",
        status: "Вградено · Запазва се автоматично",
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
        status: `DigitalOcean Read: ${digitalOceanStatus.label.toLocaleLowerCase("bg-BG")}`,
      }),
      createActionCard({
        title:
          testerAuth?.configured && testerAuth?.registrationEnabled
            ? "Тестови профили"
            : "Активирай тестови профили",
        description:
          testerAuth?.configured && testerAuth?.registrationEnabled
            ? "Входът е свързан със Supabase. Покажи кода за покана."
            : "Добавя четирите защитени production настройки чрез DigitalOcean моста.",
        action:
          testerAuth?.configured && testerAuth?.registrationEnabled
            ? "show-tester-invite"
            : "activate-tester-auth",
        icon: "fa-solid fa-user-plus",
        status:
          testerAuth?.configured && testerAuth?.registrationEnabled
            ? "Работи · Само за собственика"
            : "Изисква точно потвърждение",
        statusClass:
          testerAuth?.configured && testerAuth?.registrationEnabled
            ? "internal"
            : "warning",
      }),
      createExternalCard({
        title: "Cloudflare",
        description: "Домейн, защита и мрежови настройки.",
        url: cloudflareUrl,
        icon: "fa-brands fa-cloudflare",
        status: `Cloudflare Read: ${cloudflareStatus.label.toLocaleLowerCase("bg-BG")}`,
      }),
      createInternalCard({
        title: "Google Drive",
        description: "Преглед и анализ на разрешени файлове.",
        targetId: "googleDriveBtn",
        icon: "fa-brands fa-google-drive",
        status: googleDriveStatus.label,
        statusClass: googleDriveStatus.className,
      }),
      createInternalCard({
        title: "Gmail",
        description: "Преглед на разрешените имейли само за четене.",
        targetId: "gmailBtn",
        icon: "fa-solid fa-envelope",
        status: gmailStatus.label,
        statusClass: gmailStatus.className,
      }),
      createInternalCard({
        title: "Google Calendar",
        description: "Преглед на предстоящите събития.",
        targetId: "googleCalendarBtn",
        icon: "fa-solid fa-calendar-days",
        status: calendarStatus.label,
        statusClass: calendarStatus.className,
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

  function showTesterAuthResult({ title: resultTitle, message, inviteCode }) {
    const panel = document.createElement("section");
    panel.className = "work-center-intro";
    addText(panel, "strong", resultTitle);
    addText(panel, "p", message);
    if (inviteCode) {
      const code = addText(panel, "code", inviteCode);
      code.dataset.testerInviteCode = "";
      const copyButton = addText(panel, "button", "Копирай кода");
      copyButton.type = "button";
      copyButton.dataset.copyTesterInvite = "";
    }
    body.prepend(panel);
  }

  async function readJson(response) {
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || "Действието не успя.");
    }
    return payload;
  }

  async function showTesterInvite() {
    const payload = await readJson(
      await fetch("/api/tester-auth/invite-code", { cache: "no-store" }),
    );
    showTesterAuthResult({
      title: "Код за тестов достъп",
      message:
        "Дай този код само на човека, на когото разрешаваш да създаде тестов профил.",
      inviteCode: payload.inviteCode,
    });
  }

  async function activateTesterAuth(card) {
    card.disabled = true;
    try {
      const prepared = await readJson(
        await fetch("/api/tester-auth/prepare", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }),
      );
      if (prepared.configured) {
        await showTesterInvite();
        return;
      }
      const approved = globalThis.confirm(
        `${prepared.message}\n\nНастройки: ${prepared.missingKeys.join(", ")}\n\nПродължаваме ли?`,
      );
      if (!approved) return;
      const result = await readJson(
        await fetch("/api/tester-auth/confirm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            confirmationId: prepared.confirmationId,
          }),
        }),
      );
      showTesterAuthResult({
        title: "Тестовите профили се активират",
        message:
          "DigitalOcean започва нов deployment. След публикуването бутонът „Създай тестов профил“ ще се появи.",
        inviteCode: result.inviteCode,
      });
    } catch (error) {
      showTesterAuthResult({
        title: "Активирането не успя",
        message: error.message,
      });
    } finally {
      card.disabled = false;
    }
  }

  async function openWorkCenter() {
    title.textContent = "Работен център";
    drawer.hidden = false;
    backdrop.hidden = false;
    sidebar.classList.remove("mobile-visible");
    body.innerHTML =
      '<div class="drawer-state"><i class="fa-solid fa-circle-notch fa-spin"></i> Зареждане…</div>';

    const [
      configResult,
      readinessResult,
      integrationsResult,
      googleResult,
      githubResult,
      testerAuthResult,
    ] = await Promise.allSettled([
      fetch("/api/public-config", { cache: "no-store" }),
      fetch("/health/ready", { cache: "no-store" }),
      fetch("/health/integrations", { cache: "no-store" }),
      fetch("/api/google/status", { cache: "no-store" }),
      fetch("/api/github/status", { cache: "no-store" }),
      fetch("/api/tester-auth/status", { cache: "no-store" }),
    ]);

    let config = FALLBACK_CONFIG;
    if (configResult.status === "fulfilled" && configResult.value.ok) {
      config = (await configResult.value.json()) || FALLBACK_CONFIG;
    }

    let readiness = null;
    if (readinessResult.status === "fulfilled" && readinessResult.value.ok) {
      readiness = await readinessResult.value.json();
    }
    let integrations = null;
    if (
      integrationsResult.status === "fulfilled" &&
      integrationsResult.value.ok
    ) {
      integrations = await integrationsResult.value.json();
    }
    let googleConnected = false;
    if (googleResult.status === "fulfilled" && googleResult.value.ok) {
      const google = await googleResult.value.json();
      googleConnected = Boolean(google.connected);
    }
    let githubConnected = false;
    if (githubResult.status === "fulfilled" && githubResult.value.ok) {
      const github = await githubResult.value.json();
      githubConnected = Boolean(github.connected);
    }
    let testerAuth = null;
    if (testerAuthResult.status === "fulfilled" && testerAuthResult.value.ok) {
      testerAuth = await testerAuthResult.value.json();
    }
    renderWorkCenter(
      config,
      readiness,
      integrations,
      {
        googleConnected,
        githubConnected,
      },
      testerAuth,
    );
  }

  body.addEventListener("click", async (event) => {
    if (event.target.closest("[data-close-work-center]")) {
      closeWorkCenter();
      return;
    }
    const copyInvite = event.target.closest("[data-copy-tester-invite]");
    if (copyInvite) {
      const inviteCode = body.querySelector("[data-tester-invite-code]");
      await globalThis.navigator?.clipboard?.writeText(
        inviteCode?.textContent || "",
      );
      copyInvite.textContent = "Копирано";
      return;
    }
    const actionCard = event.target.closest("[data-work-center-action]");
    if (actionCard?.dataset.workCenterAction === "activate-tester-auth") {
      await activateTesterAuth(actionCard);
      return;
    }
    if (actionCard?.dataset.workCenterAction === "show-tester-invite") {
      try {
        await showTesterInvite();
      } catch (error) {
        showTesterAuthResult({
          title: "Кодът не е достъпен",
          message: error.message,
        });
      }
      return;
    }
    const internalCard = event.target.closest("[data-work-center-target]");
    if (!internalCard) return;
    if (internalCard.dataset.workCenterTarget === "chat") {
      closeWorkCenter();
      return;
    }
    document.getElementById(internalCard.dataset.workCenterTarget)?.click();
  });
  button.addEventListener("click", openWorkCenter);

  globalThis.SynchronWorkCenter = Object.freeze({
    openWorkCenter,
    resolveCoreStatus,
    resolveToolStatus,
    safeHttpsUrl,
  });
})();
