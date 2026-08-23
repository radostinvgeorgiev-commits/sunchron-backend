(() => {
  const REPOSITORY_URL =
    "https://github.com/radostinvgeorgiev-commits/sunchron-backend";
  const MCP_RESOURCE_URL = "https://cloudaicore.com/mcp";
  const PUBLIC_REGISTRATION_URL = "https://cloudaicore.com/register";
  const CHATGPT_PLUGINS_URL = "https://chatgpt.com/plugins";
  const CHATGPT_APP_GUIDE_URL =
    "https://developers.openai.com/plugins/deploy/connect-chatgpt";
  const FALLBACK_CONFIG = Object.freeze({
    googleCloudConsoleUrl: "https://console.cloud.google.com/run",
  });
  const STATUS_REFRESH_INTERVAL_MS = 30_000;

  const button = document.getElementById("workCenterBtn");
  const drawer = document.getElementById("dataDrawer");
  const backdrop = document.getElementById("drawerBackdrop");
  const title = document.getElementById("dataDrawerTitle");
  const body = document.getElementById("dataDrawerBody");
  const sidebar = document.getElementById("sidebar");
  if (!button || !drawer || !backdrop || !title || !body || !sidebar) return;

  let refreshTimer = null;
  let refreshInFlight = false;

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
    const wasOpen = !drawer.hidden;
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
    drawer.hidden = true;
    backdrop.hidden = true;
    if (wasOpen) {
      document.dispatchEvent(
        new document.defaultView.CustomEvent(
          "synchron:data-drawer-closed",
        ),
      );
    }
    document.getElementById("chatInput")?.focus();
  }

  function resolveCoreStatus(readiness, integrations) {
    const chat = integrations?.tools?.find(
      (tool) => tool.id === "synchron-agent-chat",
    );
    const memory = integrations?.tools?.find(
      (tool) => tool.id === "google-firestore-memory",
    );
    if (chat && memory) {
      if (
        chat.healthStatus === "healthy" &&
        chat.liveVerified === true &&
        memory.healthStatus === "healthy" &&
        memory.liveVerified === true
      ) {
        return {
          label: "AI ядро и постоянна памет: свързани · работят",
          className: "internal",
        };
      }
      return {
        label: "AI ядрото или паметта: проверката е неуспешна",
        className: "warning",
      };
    }
    if (integrations) {
      return {
        label: "Статусът на ядрото не е потвърден от live проверката",
        className: "warning",
      };
    }
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
    {
      connected = true,
      connectionName = "услугата",
      liveCheck = null,
    } = {},
  ) {
    if (!Array.isArray(integrations?.tools)) {
      return {
        label: "Не е проверено",
        className: "warning",
      };
    }
    const tool = integrations?.tools?.find((item) => item.id === toolId);
    if (!tool?.enabled || !tool?.executable) {
      return {
        label: "Грешка · адаптерът не е изпълним",
        className: "warning",
      };
    }
    if (typeof tool.liveVerified !== "boolean") {
      if (!tool.configured) {
        return {
          label: "Не е конфигуриран",
          className: "warning",
        };
      }
      if (
        liveCheck?.checked === true &&
        liveCheck.ok === true &&
        liveCheck.connected === false
      ) {
        return {
          label: `Изисква еднократен вход в ${connectionName}`,
          className: "warning",
        };
      }
      if (liveCheck?.checked === true && liveCheck.ok !== true) {
        const code = liveCheck.statusCode ? ` (${liveCheck.statusCode})` : "";
        return {
          label: `${connectionName}: проверката неуспешна${code}`,
          className: "warning",
        };
      }
      if (!connected) {
        return {
          label: `Изисква еднократен вход в ${connectionName}`,
          className: "warning",
        };
      }
      if (tool.healthStatus === "degraded" && tool.availabilityReason) {
        return {
          label: tool.availabilityReason,
          className: "warning",
        };
      }
      return {
        label: "Не е проверено",
        className: "warning",
      };
    }
    const detail = [
      tool.availabilityCode,
      tool.httpStatus ? `HTTP ${tool.httpStatus}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    const withDetail = (label) => (detail ? `${label} · ${detail}` : label);
    if (tool.authenticationStatus === "requires_connection") {
      return {
        label: withDetail("Изисква свързване"),
        className: "warning",
      };
    }
    if (tool.authenticationStatus === "no_access") {
      return {
        label: withDetail("Няма достъп"),
        className: "warning",
      };
    }
    if (!tool.configured) {
      return {
        label: withDetail("Изисква вход"),
        className: "warning",
      };
    }
    if (tool.healthStatus !== "healthy" || tool.liveVerified !== true) {
      return {
        label: withDetail("Грешка"),
        className: "warning",
      };
    }
    if (toolId === "openai-codex") {
      return {
        label: "Готово · вътрешен инструмент",
        className: "internal",
      };
    }
    if (tool.requiresConfirmation) {
      return {
        label: "Изисква потвърждение",
        className: "warning",
      };
    }
    if (
      ["github-read", "github-write", "github-confirmed-write"].includes(
        toolId,
      ) &&
      tool.authenticationStatus === "authenticated"
    ) {
      return {
        label:
          toolId === "github-read"
            ? "Свързано · GitHub Read · Работи"
            : "Свързано · Работи",
        className: "internal",
      };
    }
    return {
      label: "Готово за изпълнение",
      className: "internal",
    };
  }

  function formatStatusTime(value) {
    if (!value) return "не е проверено";
    try {
      return new Intl.DateTimeFormat("bg-BG", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }).format(new Date(value));
    } catch {
      return "не е проверено";
    }
  }

  function renderLiveStatusMeta(checkedAt) {
    const meta = document.createElement("div");
    meta.className = "work-center-live-meta";
    meta.setAttribute("role", "status");
    addText(
      meta,
      "span",
      `Последна реална проверка: ${formatStatusTime(checkedAt)} · автоматично опресняване на 30 секунди.`,
    );
    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.className = "work-center-refresh";
    refresh.dataset.refreshWorkCenter = "";
    refresh.textContent = "Опреси сега";
    meta.appendChild(refresh);
    return meta;
  }

  function resolveCapabilityState(
    integrations,
    toolId,
    { connected = true, liveCheck = null } = {},
  ) {
    if (!Array.isArray(integrations?.tools)) return "unavailable";
    const tool = integrations.tools.find((item) => item.id === toolId);
    if (!tool?.configured || !tool?.enabled || !tool?.executable) {
      return "unavailable";
    }
    if (tool.authenticationStatus === "requires_connection") return "action";
    if (
      tool.authenticationStatus === "no_access" ||
      tool.healthStatus !== "healthy" ||
      tool.liveVerified !== true
    ) {
      return "unavailable";
    }
    if (liveCheck?.checked === true && liveCheck.ok !== true) {
      return "unavailable";
    }
    const connectionReady =
      tool.authenticationStatus === "public" || connected;
    return connectionReady && !tool.requiresConfirmation ? "working" : "action";
  }

  function buildCurrentCapabilities(
    readiness,
    integrations,
    sessions,
    testerAuth,
    liveChecks = {},
  ) {
    const coreTools = integrations?.tools || [];
    const liveChat = coreTools.find(
      (tool) => tool.id === "synchron-agent-chat",
    );
    const liveMemory = coreTools.find(
      (tool) => tool.id === "google-firestore-memory",
    );
    const coreReady = integrations
      ? Boolean(
          liveChat &&
            liveMemory &&
            liveChat.healthStatus === "healthy" &&
            liveChat.liveVerified === true &&
            liveMemory.healthStatus === "healthy" &&
            liveMemory.liveVerified === true,
        )
      : readiness?.status === "ready" &&
        readiness?.checks?.chatAgent?.ready === true &&
        readiness?.checks?.memory?.ready === true;
    const bridge = readiness?.checks?.bridge;
    const bridgeConfigured =
      bridge?.configured === true &&
      bridge?.responding === true &&
      bridge?.tools >= 11 &&
      bridge?.authentication?.chatgptOAuthReady === true;
    const bridgeReady =
      bridgeConfigured &&
      bridge?.authentication?.tokenExchange?.tokenExchange === "success";
    const identityPlatform = integrations?.dependencies?.identityPlatform;
    const testerStatus =
      identityPlatform?.healthStatus === "healthy" &&
      identityPlatform?.liveVerified === true
        ? "working"
        : identityPlatform?.authenticationStatus === "requires_connection"
          ? "action"
          : "unavailable";
    return [
      {
        label: "AI разговор и постоянна памет",
        state: coreReady ? "working" : "unavailable",
      },
      {
        label: "ChatGPT MCP мост",
        state: bridgeReady
          ? "working"
          : bridgeConfigured
            ? "action"
            : "unavailable",
      },
      {
        label: "GitHub Read",
        state: resolveCapabilityState(integrations, "github-read", {
          connected: Boolean(sessions.githubConnected),
          liveCheck: liveChecks.github,
        }),
      },
      {
        label: "GitHub запис с точно потвърждение",
        state: resolveCapabilityState(integrations, "github-confirmed-write", {
          connected: Boolean(sessions.githubConnected),
          liveCheck: liveChecks.github,
        }),
      },
      {
        label: "Google Drive",
        state: resolveCapabilityState(integrations, "google-drive-read", {
          connected: Boolean(sessions.googleConnected),
          liveCheck: liveChecks.google,
        }),
      },
      {
        label: "Gmail",
        state: resolveCapabilityState(integrations, "gmail-read", {
          connected: Boolean(sessions.googleConnected),
          liveCheck: liveChecks.google,
        }),
      },
      {
        label: "Google Calendar",
        state: resolveCapabilityState(integrations, "google-calendar-read", {
          connected: Boolean(sessions.googleConnected),
          liveCheck: liveChecks.google,
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
    liveChecks = {},
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
      liveChecks,
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

  function renderActionCenter({
    tasks = [],
    workspace = null,
    audit = [],
    memories = [],
  } = {}) {
    const section = document.createElement("section");
    section.className = "action-center";
    section.setAttribute("aria-labelledby", "actionCenterTitle");
    const heading = addText(
      section,
      "h3",
      "Център за действие",
      "action-center-title",
    );
    heading.id = "actionCenterTitle";
    addText(
      section,
      "p",
      "Какво е важно, какво чака решение и какво AI CORE може да продължи.",
      "action-center-note",
    );

    const state = workspace?.state || {};
    const projects = Array.isArray(state.projects) ? state.projects : [];
    const activeProject =
      projects.find((project) => project.id === state.activeProjectId) ||
      projects[0] ||
      null;
    const activities = Array.isArray(state.activities) ? state.activities : [];
    const waitingTasks = tasks.filter((task) => task.status === "blocked");
    const actionableTasks = tasks.filter((task) =>
      ["draft", "ready", "in_progress"].includes(task.status),
    );
    const waitingActivities = activities.filter(
      (activity) => activity.status === "needs-input",
    );
    const recentApprovalRequests = audit.filter(
      (event) => event.outcome === "requested" || event.decision === "confirm",
    );
    const lastCompleted = audit.find((event) => event.outcome === "succeeded");

    const cards = [
      {
        label: "Важно днес",
        value:
          activeProject?.run?.nextStep ||
          activeProject?.objective ||
          "Избери следваща стъпка за активния проект.",
        targetId: "workContextBtn",
        icon: "fa-solid fa-compass",
      },
      {
        label: "Чака твоето решение",
        value: `${waitingTasks.length + waitingActivities.length} задачи или изпълнения`,
        targetId: "focusBtn",
        icon: "fa-solid fa-hand",
        tone: waitingTasks.length + waitingActivities.length ? "warning" : "ok",
      },
      {
        label: "AI CORE може да продължи",
        value: `${actionableTasks.length} незавършени задачи`,
        targetId: "focusBtn",
        icon: "fa-solid fa-forward",
      },
      {
        label: "Последни заявки за одобрение",
        value: `${recentApprovalRequests.length} в безопасния журнал`,
        targetId: "permissionsBtn",
        icon: "fa-solid fa-circle-check",
        tone: recentApprovalRequests.length ? "warning" : "ok",
      },
      {
        label: "Последно извършено",
        value: lastCompleted
          ? `${lastCompleted.action || "действие"} · ${lastCompleted.timestamp || "без дата"}`
          : "Няма записано успешно действие.",
        targetId: "permissionsBtn",
        icon: "fa-solid fa-clock-rotate-left",
      },
      {
        label: "Контекст",
        value: `${projects.length} проекта · ${memories.length} управлявани спомена`,
        targetId: "memoryBtn",
        icon: "fa-solid fa-layer-group",
      },
    ];

    const grid = document.createElement("div");
    grid.className = "action-center-grid";
    for (const item of cards) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = `action-center-card ${item.tone || "neutral"}`;
      card.dataset.workCenterTarget = item.targetId;
      const icon = document.createElement("span");
      icon.className = "action-center-icon";
      icon.innerHTML = `<i class="${item.icon}" aria-hidden="true"></i>`;
      const content = document.createElement("span");
      addText(content, "strong", item.label);
      addText(content, "span", item.value);
      card.append(icon, content);
      grid.appendChild(card);
    }
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
      const tokenExchange = bridge.authentication?.tokenExchange;
      if (tokenExchange?.tokenExchange === "success") {
        return {
          label: `${bridge.tools} инструмента · OAuth е проверен`,
          className: "internal",
        };
      }
      if (tokenExchange?.tokenExchange === "failed") {
        return {
          label: `${bridge.tools} инструмента · OAuth тестът е неуспешен`,
          className: "warning",
        };
      }
      return {
        label: `${bridge.tools} инструмента · готов за свързване`,
        className: "warning",
      };
    }
    return {
      label: "Мостът още не е потвърден",
      className: "warning",
    };
  }

  function resolveIdentityPlatformStatus(integrations, testerAuth) {
    const identity = integrations?.dependencies?.identityPlatform;
    if (!identity || typeof identity.liveVerified !== "boolean") {
      return {
        label: "Не е проверено",
        className: "warning",
      };
    }
    const detail = [
      identity.availabilityCode,
      identity.httpStatus ? `HTTP ${identity.httpStatus}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    const withDetail = (label) => (detail ? `${label} · ${detail}` : label);
    if (identity.authenticationStatus === "requires_connection") {
      return {
        label: withDetail("Изисква свързване"),
        className: "warning",
      };
    }
    if (identity.authenticationStatus === "no_access") {
      return {
        label: withDetail("Няма достъп"),
        className: "warning",
      };
    }
    if (!identity.configured) {
      return {
        label: withDetail("Изисква вход"),
        className: "warning",
      };
    }
    if (identity.healthStatus !== "healthy" || identity.liveVerified !== true) {
      return {
        label: withDetail("Грешка"),
        className: "warning",
      };
    }
    return {
      label:
        testerAuth?.configured && testerAuth?.registrationEnabled
          ? "Свързано · Работи · Нормална регистрация"
          : "Свързано · Работи",
      className: "internal",
    };
  }

  function renderWorkCenter(
    config,
    readiness = null,
    integrations = null,
    sessions = {},
    testerAuth = null,
    actionCenter = null,
    liveChecks = {},
    checkedAt = null,
  ) {
    const googleCloudConsoleUrl = safeHttpsUrl(
      config.googleCloudConsoleUrl,
      FALLBACK_CONFIG.googleCloudConsoleUrl,
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
    body.appendChild(renderLiveStatusMeta(checkedAt));
    body.appendChild(renderActionCenter(actionCenter || {}));
    body.appendChild(
      renderCurrentCapabilities(
        readiness,
        integrations,
        sessions,
        testerAuth,
        liveChecks,
      ),
    );

    const grid = document.createElement("section");
    grid.className = "work-center-grid";
    grid.setAttribute("aria-label", "Услуги на проекта");
    const coreStatus = resolveCoreStatus(readiness, integrations);
    const githubReadStatus = resolveToolStatus(integrations, "github-read", {
      connected: Boolean(sessions.githubConnected),
      connectionName: "GitHub",
      liveCheck: liveChecks.github,
    });
    const googleCloudStatus = resolveToolStatus(
      integrations,
      "google-cloud-read",
      { liveCheck: liveChecks.googleCloud },
    );
    const googleDriveStatus = resolveToolStatus(
      integrations,
      "google-drive-read",
      {
        connected: Boolean(sessions.googleConnected),
        connectionName: "Google",
        liveCheck: liveChecks.google,
      },
    );
    const gmailStatus = resolveToolStatus(integrations, "gmail-read", {
      connected: Boolean(sessions.googleConnected),
      connectionName: "Google",
      liveCheck: liveChecks.google,
    });
    const calendarStatus = resolveToolStatus(
      integrations,
      "google-calendar-read",
      {
        connected: Boolean(sessions.googleConnected),
        connectionName: "Google",
        liveCheck: liveChecks.google,
      },
    );
    const chatGptAppStatus = resolveChatGptAppStatus(readiness);
    const identityPlatformStatus = resolveIdentityPlatformStatus(
      integrations,
      testerAuth,
    );
    const chatGptAppCard = createActionCard({
      title: "ChatGPT приложение — AI CORE",
      description:
        "Свързва ChatGPT с разрешените инструменти чрез защитен OAuth вход.",
      action: "show-chatgpt-app-setup",
      icon: "fa-solid fa-plug-circle-check",
      status: chatGptAppStatus.label,
      statusClass: chatGptAppStatus.className,
      actionLabel: "Покажи адреса и точните стъпки",
    });
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
        title: "Google Cloud",
        description: "Cloud Run, Firestore, Identity Platform и Secret Manager.",
        url: googleCloudConsoleUrl,
        icon: "fa-brands fa-google",
        status: `Google Cloud Read: ${googleCloudStatus.label.toLocaleLowerCase("bg-BG")}`,
      }),
      createInternalCard({
        title: "Системен контрол",
        description:
          "Ядро, инструменти и Google Cloud runtime настройки без показване на тайни.",
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
      createExternalCard({
        title: "Потребителски профили",
        description:
          testerAuth?.configured && testerAuth?.registrationEnabled
            ? "Нормална регистрация с име, имейл и парола."
            : "Identity Platform се управлява само през Google Cloud Console.",
        url:
          testerAuth?.configured && testerAuth?.registrationEnabled
            ? PUBLIC_REGISTRATION_URL
            : googleCloudConsoleUrl,
        icon: "fa-solid fa-user-plus",
        status: identityPlatformStatus.label,
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
      "За AI CORE се създава нов ChatGPT plugin. Не избирай готовите Google Drive, Gmail или Google Calendar — те са отделни Google връзки.",
    );

    const steps = document.createElement("ol");
    steps.className = "chatgpt-app-steps";
    [
      "На компютър отвори ChatGPT → Settings → Security and login и включи Developer mode.",
      "Отвори страницата Plugins и натисни бутона + за нова връзка.",
      "Въведи име AI CORE и кратко описание. Под Connection избери public endpoint.",
      "В полето MCP server URL постави целия адрес, показан отдолу, включително https:// и /mcp.",
      "Създай връзката, прегледай откритите инструменти и завърши OAuth входа в AI CORE.",
    ].forEach((step) => addText(steps, "li", step));
    panel.appendChild(steps);

    addText(
      panel,
      "span",
      "Постави точно този адрес в полето „MCP server URL“:",
      "chatgpt-app-label",
    );
    const endpoint = addText(
      panel,
      "code",
      MCP_RESOURCE_URL,
      "chatgpt-app-endpoint",
    );
    endpoint.dataset.mcpResourceUrl = "";
    addText(
      panel,
      "p",
      "Това е публичният MCP адрес, не парола или таен код. Завършекът /mcp е правилен и трябва да остане.",
      "chatgpt-app-note",
    );

    const actions = document.createElement("div");
    actions.className = "chatgpt-app-actions";
    const chatGptLink = addText(
      actions,
      "a",
      "Отвори ChatGPT Plugins",
      "chatgpt-app-link",
    );
    chatGptLink.href = CHATGPT_PLUGINS_URL;
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

  async function refreshWorkCenter({ showLoading = false } = {}) {
    if (refreshInFlight) return;
    refreshInFlight = true;
    if (showLoading) {
      body.innerHTML =
        '<div class="drawer-state"><i class="fa-solid fa-circle-notch fa-spin"></i> Проверка на връзките…</div>';
    }

    try {
      const [
        configResult,
        readinessResult,
        integrationsResult,
        googleResult,
        githubResult,
        testerAuthResult,
        tasksResult,
        workspaceResult,
        auditResult,
        memoriesResult,
      ] = await Promise.allSettled([
        fetch("/api/public-config", { cache: "no-store" }),
        fetch("/health/ready", { cache: "no-store" }),
        fetch("/health/integrations", { cache: "no-store" }),
        fetch("/api/google/status", { cache: "no-store" }),
        fetch("/api/github/status", { cache: "no-store" }),
        fetch("/api/tester-auth/status", { cache: "no-store" }),
        fetch("/api/tasks?unfinished=true&limit=20", { cache: "no-store" }),
        fetch("/api/workspaces", { cache: "no-store" }),
        fetch("/permissions/audit?limit=30", { cache: "no-store" }),
        fetch("/memory/profile", { cache: "no-store" }),
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

      const googleCheck = {
        checked: googleResult.status === "fulfilled",
        ok: googleResult.status === "fulfilled" && googleResult.value.ok,
        statusCode:
          googleResult.status === "fulfilled" ? googleResult.value.status : null,
        connected: false,
      };
      if (googleResult.status === "fulfilled") {
        try {
          const google = await googleResult.value.json();
          googleCheck.connected = google?.connected === true;
        } catch {
          // The HTTP status remains the source of truth when the response is not JSON.
        }
      }

      const githubCheck = {
        checked: githubResult.status === "fulfilled",
        ok: githubResult.status === "fulfilled" && githubResult.value.ok,
        statusCode:
          githubResult.status === "fulfilled" ? githubResult.value.status : null,
        connected: false,
      };
      if (githubResult.status === "fulfilled") {
        try {
          const github = await githubResult.value.json();
          githubCheck.connected = github?.connected === true;
        } catch {
          // The HTTP status remains the source of truth when the response is not JSON.
        }
      }

      const googleCloudTool = integrations?.tools?.find(
        (tool) => tool.id === "google-cloud-read",
      );
      const liveChecks = {
        google: googleCheck,
        github: githubCheck,
        googleCloud: googleCloudTool
          ? {
              checked: true,
              ok: googleCloudTool.healthStatus === "healthy",
              statusCode: null,
            }
          : null,
      };
      let testerAuth = null;
      if (testerAuthResult.status === "fulfilled" && testerAuthResult.value.ok) {
        testerAuth = await testerAuthResult.value.json();
      }
      const actionCenter = {
        tasks:
          tasksResult.status === "fulfilled" && tasksResult.value.ok
            ? (await tasksResult.value.json()).items || []
            : [],
        workspace:
          workspaceResult.status === "fulfilled" && workspaceResult.value.ok
            ? await workspaceResult.value.json()
            : null,
        audit:
          auditResult.status === "fulfilled" && auditResult.value.ok
            ? (await auditResult.value.json()).events || []
            : [],
        memories:
          memoriesResult.status === "fulfilled" && memoriesResult.value.ok
            ? (await memoriesResult.value.json()).items || []
            : [],
      };
      renderWorkCenter(
        config,
        readiness,
        integrations,
        {
          googleConnected: googleCheck.connected,
          githubConnected: githubCheck.connected,
        },
        testerAuth,
        actionCenter,
        liveChecks,
        new Date().toISOString(),
      );
    } finally {
      refreshInFlight = false;
    }
  }

  async function openWorkCenter() {
    title.textContent = "Работен център";
    drawer.hidden = false;
    backdrop.hidden = false;
    sidebar.classList.remove("mobile-visible");
    if (refreshTimer) clearInterval(refreshTimer);
    await refreshWorkCenter({ showLoading: true });
    refreshTimer = setInterval(() => {
      if (!drawer.hidden) refreshWorkCenter();
    }, STATUS_REFRESH_INTERVAL_MS);
  }

  body.addEventListener("click", async (event) => {
    if (event.target.closest("[data-refresh-work-center]")) {
      await refreshWorkCenter();
      return;
    }
    if (event.target.closest("[data-close-work-center]")) {
      closeWorkCenter();
      return;
    }
    const actionCard = event.target.closest("[data-work-center-action]");
    if (actionCard?.dataset.workCenterAction === "show-chatgpt-app-setup") {
      showChatGptAppSetup(actionCard);
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
