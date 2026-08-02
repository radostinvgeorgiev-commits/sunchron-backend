(() => {
  const REPOSITORY_URL =
    "https://github.com/radostinvgeorgiev-commits/sunchron-backend";
  const MCP_RESOURCE_URL = "https://synchron.foundation/mcp";
  const PUBLIC_REGISTRATION_URL = "https://synchron.foundation/register";
  const PUBLIC_WWW_URL = "https://www.synchron.foundation/";
  const CHATGPT_APP_GUIDE_URL =
    "https://developers.openai.com/apps-sdk/deploy/testing";
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
    status = "Вградено и работи в AI CORE",
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
    actionLabel = "Натисни за активиране",
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
    addText(content, "span", actionLabel, "work-center-action-label");
    card.appendChild(content);

    const arrow = document.createElement("i");
    arrow.className = "fa-solid fa-chevron-right work-center-arrow";
    arrow.setAttribute("aria-hidden", "true");
    card.appendChild(arrow);
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
    if (!Array.isArray(integrations?.tools)) {
      return {
        label: "Не е проверено",
        className: "warning",
      };
    }
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

  function resolveCapabilityState(
    integrations,
    toolId,
    { connected = true } = {},
  ) {
    if (!Array.isArray(integrations?.tools)) return "unavailable";
    const tool = integrations.tools.find((item) => item.id === toolId);
    if (!tool?.configured || !tool?.enabled || !tool?.executable) {
      return "unavailable";
    }
    return connected ? "working" : "action";
  }

  function buildCurrentCapabilities(
    readiness,
    integrations,
    sessions,
    testerAuth,
  ) {
    const coreReady =
      readiness?.status === "ready" &&
      readiness?.checks?.chatAgent?.ready === true &&
      readiness?.checks?.memory?.ready === true;
    const bridge = readiness?.checks?.bridge;
    const bridgeReady =
      bridge?.configured === true &&
      bridge?.responding === true &&
      bridge?.tools >= 11 &&
      bridge?.authentication?.chatgptOAuthReady === true;
    const testerStatus = testerAuth
      ? testerAuth.configured && testerAuth.registrationEnabled
        ? "working"
        : "action"
      : "unavailable";
    const githubWrite = integrations?.tools?.find(
      (item) => item.id === "github-write",
    );
    const githubWriteDisabled =
      githubWrite?.availabilityCode === "COPILOT_AUTOMATION_DISABLED";

    return [
      {
        label: "AI разговор и постоянна памет",
        state: coreReady ? "working" : "unavailable",
      },
      {
        label: "ChatGPT MCP мост",
        state: bridgeReady ? "working" : "unavailable",
      },
      {
        label: "GitHub Read",
        state: resolveCapabilityState(integrations, "github-read"),
      },
      {
        label: githubWriteDisabled
          ? "GitHub запис · изключен в режим без Copilot"
          : "GitHub запис с точно потвърждение",
        state: resolveCapabilityState(integrations, "github-write", {
          connected: Boolean(sessions.githubConnected),
        }),
      },
      {
        label: "Google Drive",
        state: resolveCapabilityState(integrations, "google-drive-read", {
          connected: Boolean(sessions.googleConnected),
        }),
      },
      {
        label: "Gmail",
        state: resolveCapabilityState(integrations, "gmail-read", {
          connected: Boolean(sessions.googleConnected),
        }),
      },
      {
        label: "Google Calendar",
        state: resolveCapabilityState(integrations, "google-calendar-read", {
          connected: Boolean(sessions.googleConnected),
        }),
      },
      { label: "Потребителски профили", state: testerStatus },
    ];
  }

  function renderCurrentCapabilities(
    readiness,
    integrations,
    sessions,
    testerAuth,
  ) {
    const section = document.createElement("section");
    section.className = "work-center-capabilities";
    section.setAttribute("aria-labelledby", "currentCapabilitiesTitle");

    const heading = addText(
      section,
      "h3",
      "Какво мога в момента?",
      "work-center-capabilities-title",
    );
    heading.id = "currentCapabilitiesTitle";
    addText(
      section,
      "p",
      "Показано е само потвърденото от живия статус на системата.",
      "work-center-capabilities-note",
    );

    const capabilities = buildCurrentCapabilities(
      readiness,
      integrations,
      sessions,
      testerAuth,
    );
    const groups = [
      { state: "working", title: "Работи сега" },
      {
        state: "action",
        title: "Изисква свързване или потвърждение",
      },
      {
        state: "unavailable",
        title: "Не е проверено или недостъпно",
      },
    ];

    const grid = document.createElement("div");
    grid.className = "work-center-capabilities-grid";
    groups.forEach(({ state, title: groupTitle }) => {
      const items = capabilities.filter((item) => item.state === state);
      const group = document.createElement("div");
      group.className = `work-center-capability-group ${state}`;
      group.dataset.capabilityGroup = state;
      addText(
        group,
        "strong",
        `${groupTitle} · ${items.length}`,
        "work-center-capability-heading",
      );
      const list = document.createElement("ul");
      if (items.length) {
        items.forEach((item) => addText(list, "li", item.label));
      } else {
        addText(list, "li", "Няма", "work-center-capability-empty");
      }
      group.appendChild(list);
      grid.appendChild(group);
    });
    section.appendChild(grid);
    return section;
  }

  function resolveChatGptAppStatus(readiness) {
    const bridge = readiness?.checks?.bridge;
    if (
      bridge?.configured === true &&
      bridge?.responding === true &&
      bridge?.authentication?.chatgptOAuthReady === true &&
      bridge?.tools >= 11
    ) {
      return {
        label: `${bridge.tools} инструмента · OAuth е готов`,
        className: "internal",
      };
    }
    return {
      label: "Мостът още не е потвърден",
      className: "warning",
    };
  }

  function renderWorkCenter(
    config,
    readiness = null,
    integrations = null,
    sessions = {},
    testerAuth = null,
    publicDomain = null,
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
      "Свързаният разговор е вътре в AI CORE. Външните услуги не получават автоматично достъп до паметта и не дават нови права на агента.",
    );
    body.appendChild(intro);
    body.appendChild(
      renderCurrentCapabilities(readiness, integrations, sessions, testerAuth),
    );

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
    const chatGptAppStatus = resolveChatGptAppStatus(readiness);
    const chatGptAppCard = createActionCard({
      title: "ChatGPT приложение — AI CORE",
      description:
        "Свързва ChatGPT с разрешените инструменти чрез защитен OAuth вход.",
      action: "show-chatgpt-app-setup",
      icon: "fa-solid fa-plug-circle-check",
      status: chatGptAppStatus.label,
      statusClass: chatGptAppStatus.className,
      actionLabel: "Покажи еднократните стъпки",
    });
    chatGptAppCard.dataset.chatgptUrl = chatgptUrl;
    const cards = [
      createInternalCard({
        title: "AI CORE — свързан разговор",
        description:
          "Този чат използва AI ядрото и разрешената постоянна памет.",
        targetId: "chat",
        icon: "fa-solid fa-brain",
        featured: true,
        status: coreStatus.label,
        statusClass: coreStatus.className,
      }),
      chatGptAppCard,
      createExternalCard({
        title: "GitHub — хранилище",
        description: "Кодът и историята на AI CORE.",
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
        title: "Публичен www адрес",
        description:
          "Отваря AI CORE директно от www.synchron.foundation за всеки посетител.",
        action: "activate-www-domain",
        icon: "fa-solid fa-globe",
        status: publicDomain?.configured
          ? "Конфигуриран в DigitalOcean"
          : "Изисква точно потвърждение",
        statusClass: publicDomain?.configured ? "internal" : "warning",
        actionLabel: publicDomain?.configured
          ? "Провери публичния адрес"
          : "Добави www адреса",
      }),
      createInternalCard({
        title: "Системен контрол",
        description:
          "Ядро, инструменти и DigitalOcean променливи без показване на тайни.",
        targetId: "systemConfigurationBtn",
        icon: "fa-solid fa-sliders",
        status: "Защитено · Само за собственика",
      }),
      createInternalCard({
        title: "Инструменти",
        description:
          "Реален статус, налични връзки и действия за всеки инструмент.",
        targetId: "toolsBtn",
        icon: "fa-solid fa-toolbox",
        status: "Вградено · Показва живото състояние",
      }),
      createActionCard({
        title:
          testerAuth?.configured && testerAuth?.registrationEnabled
            ? "Потребителски профили"
            : "Активирай потребителски профили",
        description:
          testerAuth?.configured && testerAuth?.registrationEnabled
            ? "Нормална регистрация с име, имейл и парола."
            : "Добавя четирите защитени production настройки чрез DigitalOcean моста.",
        action:
          testerAuth?.configured && testerAuth?.registrationEnabled
            ? "copy-registration-link"
            : "activate-tester-auth",
        icon: "fa-solid fa-user-plus",
        status:
          testerAuth?.configured && testerAuth?.registrationEnabled
            ? "Работи · Нормална регистрация"
            : "Изисква точно потвърждение",
        statusClass:
          testerAuth?.configured && testerAuth?.registrationEnabled
            ? "internal"
            : "warning",
        actionLabel:
          testerAuth?.configured && testerAuth?.registrationEnabled
            ? "Копирай адреса за регистрация"
            : "Натисни за активиране",
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

  function showTesterAuthResult({ title: resultTitle, message, anchor }) {
    const panel = document.createElement("section");
    panel.className = "work-center-intro";
    panel.dataset.testerAuthResult = "";
    addText(panel, "strong", resultTitle);
    addText(panel, "p", message);
    body.querySelector("[data-tester-auth-result]")?.remove();
    if (anchor?.parentNode) {
      anchor.insertAdjacentElement("afterend", panel);
    } else {
      body.prepend(panel);
    }
    panel.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  }

  function showChatGptAppSetup(card) {
    body.querySelector("[data-chatgpt-app-setup]")?.remove();
    const panel = document.createElement("section");
    panel.className = "work-center-intro chatgpt-app-setup";
    panel.dataset.chatgptAppSetup = "";
    addText(panel, "strong", "Свържи AI CORE с ChatGPT");
    addText(
      panel,
      "p",
      "Мостът е готов. Създаването на приложението се прави еднократно от ChatGPT в браузър на компютър, не от приложението за iPhone.",
    );

    const steps = document.createElement("ol");
    steps.className = "chatgpt-app-steps";
    [
      "Отвори chatgpt.com на компютър и влез в своя профил.",
      "В Settings отвори Apps / Connectors и включи Developer mode. За служебен workspace отвори Workspace settings → Apps.",
      "Избери Create app, напиши име AI CORE и постави MCP адреса отдолу.",
      "Завърши OAuth входа в AI CORE. Не изпращай парола или код в чата.",
    ].forEach((step) => addText(steps, "li", step));
    panel.appendChild(steps);

    addText(panel, "span", "MCP адрес", "chatgpt-app-label");
    const endpoint = addText(
      panel,
      "code",
      MCP_RESOURCE_URL,
      "chatgpt-app-endpoint",
    );
    endpoint.dataset.mcpResourceUrl = "";

    const actions = document.createElement("div");
    actions.className = "chatgpt-app-actions";
    const copyButton = addText(
      actions,
      "button",
      "Копирай MCP адреса",
      "chatgpt-app-copy",
    );
    copyButton.type = "button";
    copyButton.dataset.copyMcpUrl = "";

    const chatGptLink = addText(
      actions,
      "a",
      "Отвори ChatGPT web",
      "chatgpt-app-link",
    );
    chatGptLink.href = safeHttpsUrl(
      card?.dataset.chatgptUrl,
      FALLBACK_CONFIG.chatgptWorkUrl,
    );
    chatGptLink.target = "_blank";
    chatGptLink.rel = "noopener noreferrer";

    const guideLink = addText(
      actions,
      "a",
      "Официални инструкции",
      "chatgpt-app-link secondary",
    );
    guideLink.href = CHATGPT_APP_GUIDE_URL;
    guideLink.target = "_blank";
    guideLink.rel = "noopener noreferrer";
    panel.appendChild(actions);

    card.insertAdjacentElement("afterend", panel);
    panel.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  }

  async function readJson(response) {
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error || "Действието не успя.");
      error.code = payload.code;
      error.status = response.status;
      throw error;
    }
    return payload;
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
        showTesterAuthResult({
          title: "Потребителските профили са активни",
          message: "Регистрацията с име, имейл и парола работи.",
          anchor: card,
        });
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
        title: "Потребителските профили се активират",
        message:
          "DigitalOcean започва нов deployment. След публикуването нормалната регистрация ще бъде достъпна.",
        anchor: card,
      });
    } catch (error) {
      if (error.code === "AUTH_REQUIRED") {
        showTesterAuthResult({
          title: "Необходим е вход на собственика",
          message:
            "Отварям защитения GitHub вход. След връщането натисни картата отново.",
          anchor: card,
        });
        globalThis.location?.assign?.("/api/github/connect");
        return;
      }
      showTesterAuthResult({
        title: "Активирането не успя",
        message: error.message,
        anchor: card,
      });
    } finally {
      card.disabled = false;
    }
  }

  async function activatePublicWwwDomain(card) {
    card.disabled = true;
    try {
      const prepared = await readJson(
        await fetch("/api/digitalocean-domain/prepare", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }),
      );
      if (prepared.configured) {
        showTesterAuthResult({
          title: "www адресът е конфигуриран",
          message: `${prepared.domain} е добавен в DigitalOcean. Отвори ${PUBLIC_WWW_URL} за крайна проверка.`,
          anchor: card,
        });
        return;
      }
      const approved = globalThis.confirm(
        `${prepared.message}\n\nАдрес: ${prepared.domain}\n\nПродължаваме ли?`,
      );
      if (!approved) return;
      const result = await readJson(
        await fetch("/api/digitalocean-domain/confirm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            confirmationId: prepared.confirmationId,
          }),
        }),
      );
      showTesterAuthResult({
        title: "www адресът се активира",
        message: `${result.domain} е добавен. DigitalOcean започва deployment; след публикуването адресът ще бъде проверен отново.`,
        anchor: card,
      });
    } catch (error) {
      if (error.code === "AUTH_REQUIRED") {
        showTesterAuthResult({
          title: "Необходим е вход на собственика",
          message:
            "Отварям защитения GitHub вход. След връщането натисни картата отново.",
          anchor: card,
        });
        globalThis.location?.assign?.("/api/github/connect");
        return;
      }
      showTesterAuthResult({
        title: "Настройването на www адреса не успя",
        message: error.code
          ? `${error.message}\nКод: ${error.code}`
          : error.message,
        anchor: card,
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
      publicDomainResult,
    ] = await Promise.allSettled([
      fetch("/api/public-config", { cache: "no-store" }),
      fetch("/health/ready", { cache: "no-store" }),
      fetch("/health/integrations", { cache: "no-store" }),
      fetch("/api/google/status", { cache: "no-store" }),
      fetch("/api/github/status", { cache: "no-store" }),
      fetch("/api/tester-auth/status", { cache: "no-store" }),
      fetch("/api/digitalocean-domain/status", { cache: "no-store" }),
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
    let publicDomain = null;
    if (
      publicDomainResult.status === "fulfilled" &&
      publicDomainResult.value.ok
    ) {
      publicDomain = await publicDomainResult.value.json();
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
      publicDomain,
    );
  }

  body.addEventListener("click", async (event) => {
    if (event.target.closest("[data-close-work-center]")) {
      closeWorkCenter();
      return;
    }
    const copyMcpUrl = event.target.closest("[data-copy-mcp-url]");
    if (copyMcpUrl) {
      await globalThis.navigator?.clipboard?.writeText(MCP_RESOURCE_URL);
      copyMcpUrl.textContent = "Копирано";
      return;
    }
    const actionCard = event.target.closest("[data-work-center-action]");
    if (actionCard?.dataset.workCenterAction === "show-chatgpt-app-setup") {
      showChatGptAppSetup(actionCard);
      return;
    }
    if (actionCard?.dataset.workCenterAction === "activate-tester-auth") {
      await activateTesterAuth(actionCard);
      return;
    }
    if (actionCard?.dataset.workCenterAction === "activate-www-domain") {
      await activatePublicWwwDomain(actionCard);
      return;
    }
    if (actionCard?.dataset.workCenterAction === "copy-registration-link") {
      await globalThis.navigator?.clipboard?.writeText(PUBLIC_REGISTRATION_URL);
      showTesterAuthResult({
        title: "Адресът за регистрация е копиран",
        message:
          "Изпрати го на човека, който иска да създаде профил. Адресът отваря директно регистрацията.",
        anchor: actionCard,
      });
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
    resolveChatGptAppStatus,
    resolveCoreStatus,
    resolveToolStatus,
    safeHttpsUrl,
  });
})();
