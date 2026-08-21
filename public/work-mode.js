(() => {
  const STORAGE_VERSION = 6;
  const WORKSPACE_ENDPOINT = "/api/workspaces";
  const PETS = Object.freeze([
    {
      id: "robot",
      symbol: "🤖",
      label: "Кори",
      description: "Технически и точен помощник.",
    },
    {
      id: "drop",
      symbol: "💧",
      label: "Капка",
      description: "Спокоен спътник за фокус.",
    },
    {
      id: "spark",
      symbol: "🔥",
      label: "Искра",
      description: "Енергия за бърза работа.",
    },
    {
      id: "owl",
      symbol: "🦉",
      label: "Бухал",
      description: "Наблюдателен и прецизен.",
    },
    {
      id: "rock",
      symbol: "🪨",
      label: "Скала",
      description: "Стабилен при трудни задачи.",
    },
    {
      id: "cat",
      symbol: "🐈",
      label: "Мяу",
      description: "Любопитен и гъвкав спътник.",
    },
  ]);
  const ROLE_LABELS = Object.freeze({
    general: "Универсален помощник",
    researcher: "Изследовател",
    organizer: "Организатор",
    documents: "Документи и поща",
    builder: "Създател на проекти",
    coder: "Codex разработчик",
  });
  const ENGINE_OPTIONS = Object.freeze({
    "ai-core": "AI CORE",
    codex: "Codex · изолиран кодов анализ",
  });
  const MODEL_OPTIONS = Object.freeze({
    auto: "Автоматичен · препоръчано",
    "gpt-5.6-sol": "GPT-5.6 Sol · най-високо качество",
    "gpt-5.6-terra": "GPT-5.6 Terra · балансиран",
    "gpt-5.6-luna": "GPT-5.6 Luna · бърз",
    "gemini-2.5-flash": "Gemini 2.5 Flash",
    "grok-4.5": "Grok 4.5 · xAI",
  });
  const PROJECT_TOOL_OPTIONS = Object.freeze([
    Object.freeze({ id: "synchron-agent-chat", label: "AI разговор" }),
    Object.freeze({ id: "synchron-tasks", label: "Задачи" }),
    Object.freeze({ id: "github-read", label: "GitHub" }),
    Object.freeze({ id: "google-drive-read", label: "Google Drive" }),
    Object.freeze({ id: "gmail-read", label: "Gmail" }),
    Object.freeze({ id: "google-calendar-read", label: "Календар" }),
    Object.freeze({ id: "google-contacts", label: "Контакти" }),
    Object.freeze({ id: "openai-web-search", label: "Интернет" }),
  ]);

  const DEFAULT_AGENTS = Object.freeze([
    Object.freeze({
      id: "synchron-builder",
      name: "Изпълни",
      role: "builder",
      model: "auto",
      purpose: "Подготвя реален резултат и показва какво е проверено.",
      engine: "ai-core",
      petId: "robot",
    }),
    Object.freeze({
      id: "research-agent",
      name: "Проучи",
      role: "researcher",
      model: "auto",
      purpose: "Проверява актуални източници и отделя фактите от изводите.",
      engine: "ai-core",
      petId: "owl",
    }),
    Object.freeze({
      id: "organizer-agent",
      name: "Организирай",
      role: "organizer",
      model: "auto",
      purpose: "Подрежда задачи и календар, като спира преди външни промени.",
      engine: "ai-core",
      petId: "rock",
    }),
    Object.freeze({
      id: "documents-agent",
      name: "Напиши",
      role: "documents",
      model: "auto",
      purpose: "Работи с разрешени файлове, документи и поща.",
      engine: "ai-core",
      petId: "cat",
    }),
    Object.freeze({
      id: "codex-agent",
      name: "Код",
      role: "coder",
      model: "gpt-5.6-terra",
      purpose: "Анализира кода без запис и без интернет.",
      engine: "codex",
      petId: "spark",
    }),
  ]);

  function agentPetId(agent) {
    if (PETS.some((pet) => pet.id === agent?.petId)) return agent.petId;
    return (
      DEFAULT_AGENTS.find((defaultAgent) => defaultAgent.id === agent?.id)
        ?.petId || "robot"
    );
  }

  let storageKey = "synchronWorkMode:anonymous";
  let workState = null;
  let remoteReady = false;
  let saveTimer = null;
  let syncStatus = "local";
  let localRevision = 0;
  let storageAvailable = true;
  let managerNotice = "";
  let editingAgentId = null;

  const elements = {
    chatInput: document.getElementById("chatInput"),
    chatModeBtn: document.getElementById("chatModeBtn"),
    workModeToolbarBtn: document.getElementById("workModeToolbarBtn"),
    workModeBtn: document.getElementById("workModeBtn"),
    workPetBtn: document.getElementById("workPetBtn"),
    workContextBtn: document.getElementById("workContextBtn"),
    projectLabel: document.getElementById("workProjectLabel"),
    agentLabel: document.getElementById("workAgentLabel"),
    pet: document.getElementById("workPet"),
    drawer: document.getElementById("dataDrawer"),
    drawerBackdrop: document.getElementById("drawerBackdrop"),
    drawerTitle: document.getElementById("dataDrawerTitle"),
    drawerBody: document.getElementById("dataDrawerBody"),
    sidebar: document.getElementById("sidebar"),
    sidebarBackdrop: document.getElementById("sidebarBackdrop"),
    commandBar: document.querySelector(".mobile-command-bar"),
  };

  function createId(prefix) {
    if (globalThis.crypto?.randomUUID) {
      return `${prefix}-${globalThis.crypto.randomUUID()}`;
    }
    return `${prefix}-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2)}`;
  }

  function defaultState() {
    return {
      version: STORAGE_VERSION,
      mode: "chat",
      activeProjectId: "starter-project",
      activeAgentId: "synchron-builder",
      petId: "robot",
      petState: "ready",
      projects: [
        {
          id: "starter-project",
          name: "Първи проект",
          objective: "",
          status: "ready",
          updatedAt: new Date().toISOString(),
          run: null,
          decisions: [],
          resources: [],
          toolIds: [],
          conversationIds: [],
        },
      ],
      agents: DEFAULT_AGENTS.map((agent) => ({ ...agent })),
      activities: [],
      preferences: {
        memoryMode: "confirm",
      },
    };
  }

  function cleanText(value, maxLength) {
    return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
  }

  function normalizeProjectRun(value) {
    if (!value || typeof value !== "object") return null;
    const summary = cleanText(value.summary, 4000);
    const nextStep = cleanText(value.nextStep, 1200);
    if (!summary && !nextStep) return null;
    return {
      sequence: Math.max(
        0,
        Math.min(Number.parseInt(value.sequence, 10) || 0, 999999),
      ),
      status: ["complete", "ready_for_next_step", "blocked"].includes(
        value.status,
      )
        ? value.status
        : "ready_for_next_step",
      summary,
      evidence: (Array.isArray(value.evidence) ? value.evidence : [])
        .slice(0, 8)
        .map((item) => cleanText(item, 500))
        .filter(Boolean),
      nextStep,
      needsUserDecision: value.needsUserDecision === true,
      codeChanged: false,
      updatedAt: cleanText(value.updatedAt, 40),
    };
  }

  function normalizeProjectDecisions(value) {
    return (Array.isArray(value) ? value : [])
      .slice(0, 20)
      .map((item) => ({
        text: cleanText(typeof item === "string" ? item : item?.text, 500),
        createdAt: cleanText(item?.createdAt, 40) || new Date().toISOString(),
      }))
      .filter((item) => item.text);
  }

  function normalizeProjectResources(value) {
    return (Array.isArray(value) ? value : [])
      .slice(0, 30)
      .map((item) => {
        let safeUrl = "";
        try {
          const parsed = new URL(cleanText(item?.url, 1000));
          if (parsed.protocol === "https:") safeUrl = parsed.href;
        } catch {
          safeUrl = "";
        }
        return {
          label: cleanText(item?.label, 120) || "Ресурс",
          url: safeUrl,
          type: item?.type === "file" ? "file" : "link",
        };
      })
      .filter((item) => item.url);
  }

  function normalizeProjectIds(value, limit) {
    return (Array.isArray(value) ? value : [])
      .slice(0, limit)
      .map((item) => cleanText(item, 80))
      .filter((item) => /^[a-z0-9][a-z0-9:_-]{0,79}$/iu.test(item));
  }

  function normalizeState(value) {
    const fallback = defaultState();
    if (!value || typeof value !== "object") return fallback;

    const projects = Array.isArray(value.projects)
      ? value.projects.slice(0, 20).map((project) => ({
          id: cleanText(project?.id, 80) || createId("project"),
          name: cleanText(project?.name, 80) || "Проект",
          objective: cleanText(project?.objective, 600),
          status: ["ready", "running", "needs-input", "blocked"].includes(
            project?.status,
          )
            ? project.status
            : "ready",
          updatedAt: cleanText(project?.updatedAt, 40),
          run: normalizeProjectRun(project?.run),
          decisions: normalizeProjectDecisions(project?.decisions),
          resources: normalizeProjectResources(project?.resources),
          toolIds: normalizeProjectIds(project?.toolIds, 20),
          conversationIds: normalizeProjectIds(project?.conversationIds, 50),
        }))
      : fallback.projects;
    const agents = Array.isArray(value.agents)
      ? value.agents.slice(0, 12).map((agent) => ({
          id: cleanText(agent?.id, 80) || createId("agent"),
          name: cleanText(agent?.name, 50) || "Личен агент",
          role: Object.hasOwn(ROLE_LABELS, agent?.role)
            ? agent.role
            : "general",
          model: Object.hasOwn(MODEL_OPTIONS, agent?.model)
            ? agent.model
            : "auto",
          purpose: cleanText(agent?.purpose, 400),
          engine: Object.hasOwn(ENGINE_OPTIONS, agent?.engine)
            ? agent.engine
            : "ai-core",
          petId: agentPetId(agent),
        }))
      : fallback.agents;
    const activities = Array.isArray(value.activities)
      ? value.activities.slice(0, 40).map((activity, index) => ({
          id:
            cleanText(activity?.id || activity?.taskId, 80) ||
            `activity-${index + 1}`,
          projectId: cleanText(activity?.projectId, 80),
          status: ["ready", "running", "needs-input", "blocked"].includes(
            activity?.status,
          )
            ? activity.status
            : "ready",
          message: cleanText(activity?.message, 240),
          verified: activity?.verified === true,
          updatedAt: cleanText(activity?.updatedAt, 40),
        }))
      : [];
    const preferences = {
      memoryMode: ["confirm", "disabled"].includes(
        value.preferences?.memoryMode,
      )
        ? value.preferences.memoryMode
        : "confirm",
    };

    if (!projects.length) projects.push(...fallback.projects);
    if (!agents.length) agents.push(...fallback.agents);
    if (
      !agents.some((agent) => agent.engine === "codex") &&
      agents.length < 12
    ) {
      agents.push(fallback.agents.find((agent) => agent.engine === "codex"));
    }
    if ((Number.parseInt(value.version, 10) || 0) < STORAGE_VERSION) {
      for (const defaultAgent of fallback.agents) {
        if (agents.length >= 12) break;
        if (!agents.some((agent) => agent.id === defaultAgent.id)) {
          agents.push({ ...defaultAgent });
        }
      }
      for (const defaultAgent of fallback.agents) {
        const existing = agents.find((agent) => agent.id === defaultAgent.id);
        if (existing) {
          Object.assign(existing, {
            name: defaultAgent.name,
            role: defaultAgent.role,
            model: defaultAgent.model,
            purpose: defaultAgent.purpose,
            engine: defaultAgent.engine,
          });
        }
      }
    }

    const activeProjectId = projects.some(
      (project) => project.id === value.activeProjectId,
    )
      ? value.activeProjectId
      : projects[0].id;
    const activeAgentId = agents.some(
      (agent) => agent.id === value.activeAgentId,
    )
      ? value.activeAgentId
      : agents[0].id;
    const petId = PETS.some((pet) => pet.id === value.petId)
      ? value.petId
      : fallback.petId;
    if ((Number.parseInt(value.version, 10) || 0) < STORAGE_VERSION) {
      const activeAgent = agents.find((agent) => agent.id === activeAgentId);
      if (activeAgent) activeAgent.petId = petId;
    }

    return {
      version: STORAGE_VERSION,
      mode: value.mode === "work" ? "work" : "chat",
      activeProjectId,
      activeAgentId,
      petId,
      petState: ["ready", "running", "needs-input", "blocked"].includes(
        value.petState,
      )
        ? value.petState
        : "ready",
      projects,
      agents,
      activities,
      preferences,
    };
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(storageKey);
      return normalizeState(raw ? JSON.parse(raw) : null);
    } catch {
      return defaultState();
    }
  }

  function pendingStorageKey() {
    return `${storageKey}:pending`;
  }

  function currentConversationId() {
    try {
      const value = cleanText(localStorage.getItem("synchronSessionId"), 80);
      return /^[a-z0-9][a-z0-9:_-]{0,79}$/iu.test(value) ? value : "";
    } catch {
      storageAvailable = false;
      return "";
    }
  }

  function hasPendingRemoteSave() {
    try {
      return localStorage.getItem(pendingStorageKey()) === "1";
    } catch {
      storageAvailable = false;
      return false;
    }
  }

  function clearPendingRemoteSave() {
    try {
      localStorage.removeItem(pendingStorageKey());
    } catch {
      storageAvailable = false;
    }
  }

  function saveState({ remote = true } = {}) {
    try {
      localStorage.setItem(storageKey, JSON.stringify(workState));
      if (remote) {
        localStorage.setItem(pendingStorageKey(), "1");
        localRevision += 1;
      }
    } catch {
      storageAvailable = false;
      syncStatus = "error";
      return false;
    }
    if (remote && remoteReady) queueRemoteSave();
    return true;
  }

  function queueRemoteSave() {
    clearTimeout(saveTimer);
    syncStatus = "saving";
    saveTimer = setTimeout(() => void persistRemoteState(), 350);
  }

  async function readJson(response) {
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || "Работната област не е достъпна.");
    }
    return payload;
  }

  async function persistRemoteState() {
    const snapshot = normalizeState(workState);
    const revision = localRevision;
    try {
      const payload = await readJson(
        await fetch(WORKSPACE_ENDPOINT, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ state: snapshot }),
        }),
      );
      if (revision === localRevision) {
        workState = normalizeState(payload.state);
        syncStatus = "synced";
        clearPendingRemoteSave();
        saveState({ remote: false });
      } else {
        queueRemoteSave();
      }
    } catch {
      syncStatus = "local";
    }
  }

  async function syncRemoteState() {
    const revision = localRevision;
    const hadPendingSave = hasPendingRemoteSave();
    try {
      const payload = await readJson(
        await fetch(WORKSPACE_ENDPOINT, { cache: "no-store" }),
      );
      remoteReady = true;
      if (hadPendingSave || revision !== localRevision) {
        syncStatus = "saving";
        await persistRemoteState();
      } else if (payload.persisted) {
        workState = normalizeState(payload.state);
        if (saveState({ remote: false })) syncStatus = "synced";
      } else {
        syncStatus = "saving";
        await persistRemoteState();
      }
      renderMode();
    } catch {
      remoteReady = true;
      syncStatus = "local";
    }
  }

  function activeProject() {
    return workState.projects.find(
      (project) => project.id === workState.activeProjectId,
    );
  }

  function activeAgent() {
    return workState.agents.find(
      (agent) => agent.id === workState.activeAgentId,
    );
  }

  function selectedPet() {
    return PETS.find((pet) => pet.id === workState.petId) || PETS[0];
  }

  function activateMobileCommand(command) {
    for (const button of elements.commandBar?.querySelectorAll("button") ||
      []) {
      button.classList.toggle("active", button.dataset.command === command);
    }
  }

  function renderMode() {
    const isWork = workState.mode === "work";
    document.body.dataset.interactionMode = workState.mode;
    elements.chatModeBtn?.setAttribute("aria-pressed", String(!isWork));
    elements.workModeToolbarBtn?.setAttribute("aria-pressed", String(isWork));
    elements.chatInput.placeholder = isWork
      ? "Какъв резултат да изработим?"
      : "Пиши на AI CORE";
    const project = activeProject();
    const agent = activeAgent();
    elements.projectLabel.textContent = isWork
      ? project?.name || "Без активен проект"
      : "Разговор";
    elements.agentLabel.textContent = agent?.name || "AI CORE";
    renderPet();
    activateMobileCommand(isWork ? "work" : "chat");
  }

  function renderPet() {
    const pet = selectedPet();
    elements.pet.textContent = pet.symbol;
    elements.pet.dataset.petId = pet.id;
    elements.pet.dataset.petState = workState.petState;
    const statusLabels = {
      running: "Работи по задачата",
      "needs-input": "Чака твое решение",
      ready: "Готово за преглед",
      blocked: "Задачата е блокирана",
    };
    const petTitle = `${pet.label}: ${statusLabels[workState.petState]}. ${pet.description}`;
    elements.workPetBtn.title = petTitle;
    elements.workPetBtn.setAttribute(
      "aria-label",
      `Избери любимец. ${petTitle}`,
    );
  }

  function setMode(mode) {
    workState.mode = mode === "work" ? "work" : "chat";
    saveState();
    renderMode();
    elements.sidebar?.classList.remove("mobile-visible");
    if (elements.sidebarBackdrop) elements.sidebarBackdrop.hidden = true;
    elements.chatInput?.focus();
  }

  function setPetState(status) {
    const next = ["ready", "running", "needs-input", "blocked"].includes(status)
      ? status
      : "ready";
    workState.petState = next;
    const project = activeProject();
    if (project && workState.mode === "work") {
      project.status = next;
      project.updatedAt = new Date().toISOString();
    }
    saveState();
    renderPet();
  }

  function closeOtherPanels() {
    elements.sidebar?.classList.remove("mobile-visible");
    if (elements.sidebarBackdrop) elements.sidebarBackdrop.hidden = true;
  }

  function addText(parent, tag, text, className) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    element.textContent = text;
    parent.appendChild(element);
    return element;
  }

  function renderProjectChoices(parent) {
    const list = document.createElement("div");
    list.className = "work-choice-list";
    for (const project of workState.projects) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "work-choice-card";
      button.classList.toggle(
        "active",
        project.id === workState.activeProjectId,
      );
      button.addEventListener("click", () => {
        workState.activeProjectId = project.id;
        saveState();
        renderMode();
        openManager();
      });
      addText(button, "strong", project.name);
      addText(button, "small", project.objective || "Още няма описана цел.");
      const contextCounts = [
        `${project.decisions.length} решения`,
        `${project.resources.length} ресурса`,
        `${project.conversationIds.length} разговора`,
      ];
      addText(button, "small", contextCounts.join(" · "));
      if (project.run?.nextStep) {
        addText(button, "small", `Следва: ${project.run.nextStep}`);
      }
      list.appendChild(button);
    }
    parent.appendChild(list);
  }

  function renderAgentChoices(parent) {
    const list = document.createElement("div");
    list.className = "work-choice-list";
    for (const agent of workState.agents) {
      const item = document.createElement("article");
      item.className = "work-agent-choice";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "work-choice-card";
      button.classList.toggle("active", agent.id === workState.activeAgentId);
      button.addEventListener("click", () => {
        workState.activeAgentId = agent.id;
        workState.petId = agent.petId;
        saveState();
        renderMode();
        openManager();
      });
      const agentPet = PETS.find((pet) => pet.id === agent.petId) || PETS[0];
      addText(button, "strong", `${agentPet.symbol} ${agent.name}`);
      addText(button, "small", agent.purpose || ROLE_LABELS[agent.role]);
      item.appendChild(button);
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "work-agent-edit";
      edit.textContent = "Редактирай";
      edit.setAttribute("aria-label", `Редактирай ${agent.name}`);
      edit.addEventListener("click", () => {
        editingAgentId = agent.id;
        workState.activeAgentId = agent.id;
        workState.petId = agent.petId;
        saveState();
        renderMode();
        openManager();
      });
      item.appendChild(edit);
      list.appendChild(item);
    }
    parent.appendChild(list);
  }

  function renderPetChoices(parent, reopen = openManager) {
    const grid = document.createElement("div");
    grid.className = "pet-choice-grid";
    for (const pet of PETS) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "pet-choice";
      button.classList.toggle("active", pet.id === workState.petId);
      button.setAttribute("aria-label", `Избери ${pet.label}`);
      button.addEventListener("click", () => {
        workState.petId = pet.id;
        const agent = activeAgent();
        if (agent) agent.petId = pet.id;
        saveState();
        renderPet();
        reopen();
      });
      addText(button, "span", pet.symbol);
      addText(button, "strong", pet.label);
      addText(button, "small", pet.description);
      grid.appendChild(button);
    }
    parent.appendChild(grid);
    addText(
      parent,
      "p",
      "Личният любимец се запазва в защитения ти профил и показва: работи, чака решение, готов е или е блокиран. Той не променя правата на AI.",
      "work-pet-status",
    );
  }

  function renderActivities(parent) {
    const activities = workState.activities.filter(
      (activity) =>
        !activity.projectId || activity.projectId === workState.activeProjectId,
    );
    if (!activities.length) {
      addText(
        parent,
        "p",
        "Когато изпълниш задача в режим Работа, тук ще се появи проверимият ѝ статус.",
        "work-storage-note",
      );
      return;
    }
    const list = document.createElement("div");
    list.className = "work-activity-list";
    const labels = {
      running: "Работи",
      "needs-input": "Чака решение",
      ready: "Готово",
      blocked: "Блокирано",
    };
    for (const activity of activities.slice(0, 8)) {
      const item = document.createElement("article");
      item.className = "work-activity-item";
      item.dataset.status = activity.status;
      addText(item, "strong", labels[activity.status] || "Задача");
      addText(item, "span", activity.message || "Работна задача");
      if (activity.verified) addText(item, "small", "Проверено");
      list.appendChild(item);
    }
    parent.appendChild(list);
  }

  function activityStatus(status) {
    if (status === "waiting_confirmation") return "needs-input";
    if (status === "failed" || status === "partial") return "blocked";
    if (status === "completed") return "ready";
    return "running";
  }

  function recordActivity(task) {
    if (!task || workState?.mode !== "work") return;
    const id = cleanText(task.taskId || task.id, 80);
    if (!id) return;
    const current = workState.activities.find((item) => item.id === id);
    const activity = {
      id,
      projectId: workState.activeProjectId,
      status: activityStatus(task.status),
      message: cleanText(task.message, 240) || "Работна задача",
      verified: task.verified === true,
      updatedAt: new Date().toISOString(),
    };
    if (current) Object.assign(current, activity);
    else workState.activities.unshift(activity);
    workState.activities = workState.activities.slice(0, 40);
    saveState();
  }

  function createProjectForm(parent) {
    const form = document.createElement("form");
    form.className = "work-manager-form";
    addText(form, "label", "Име на проекта").htmlFor = "newWorkProjectName";
    const name = document.createElement("input");
    name.id = "newWorkProjectName";
    name.maxLength = 80;
    name.required = true;
    form.appendChild(name);
    addText(form, "label", "Какъв резултат искаш?").htmlFor =
      "newWorkProjectObjective";
    const objective = document.createElement("textarea");
    objective.id = "newWorkProjectObjective";
    objective.maxLength = 600;
    objective.required = true;
    form.appendChild(objective);
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = "Създай и избери проекта";
    form.appendChild(submit);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const project = {
        id: createId("project"),
        name: cleanText(name.value, 80),
        objective: cleanText(objective.value, 600),
        status: "ready",
        updatedAt: new Date().toISOString(),
        run: null,
        decisions: [],
        resources: [],
        toolIds: [],
        conversationIds: [],
      };
      if (!project.name) return;
      const previousActiveProjectId = workState.activeProjectId;
      workState.projects.unshift(project);
      workState.activeProjectId = project.id;
      if (!saveState()) {
        workState.projects = workState.projects.filter(
          (item) => item.id !== project.id,
        );
        workState.activeProjectId = previousActiveProjectId;
        managerNotice =
          "Проектът не е запазен. Провери дали браузърът позволява съхранение на данни и опитай отново.";
        openManager();
        return;
      }
      managerNotice = `Проектът „${project.name}“ е създаден и избран.`;
      renderMode();
      openManager();
    });
    parent.appendChild(form);
  }

  function renderProjectContextForm(parent) {
    const project = activeProject();
    if (!project) return;

    const form = document.createElement("form");
    form.className = "work-manager-form work-project-context-form";
    addText(form, "h4", `Контекст: ${project.name}`);

    addText(form, "label", "Цел").htmlFor = "activeProjectObjective";
    const objective = document.createElement("textarea");
    objective.id = "activeProjectObjective";
    objective.maxLength = 600;
    objective.value = project.objective;
    form.appendChild(objective);

    addText(form, "label", "Състояние").htmlFor = "activeProjectStatus";
    const status = document.createElement("select");
    status.id = "activeProjectStatus";
    for (const [id, label] of Object.entries({
      ready: "Готов за работа",
      running: "В работа",
      "needs-input": "Чака решение",
      blocked: "Блокиран",
    })) {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = label;
      status.appendChild(option);
    }
    status.value = project.status;
    form.appendChild(status);

    addText(form, "label", "Важни решения — по едно на ред").htmlFor =
      "activeProjectDecisions";
    const decisions = document.createElement("textarea");
    decisions.id = "activeProjectDecisions";
    decisions.maxLength = 10000;
    decisions.value = project.decisions.map((item) => item.text).join("\n");
    form.appendChild(decisions);

    addText(form, "label", "Файлове и линкове — Име | https://…").htmlFor =
      "activeProjectResources";
    const resources = document.createElement("textarea");
    resources.id = "activeProjectResources";
    resources.maxLength = 12000;
    resources.value = project.resources
      .map((item) => `${item.label} | ${item.url}`)
      .join("\n");
    form.appendChild(resources);

    addText(
      form,
      "p",
      "Разрешени инструменти за този проект",
      "work-form-label",
    );
    const tools = document.createElement("div");
    tools.className = "work-project-tools";
    for (const item of PROJECT_TOOL_OPTIONS) {
      const label = document.createElement("label");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = item.id;
      checkbox.checked = project.toolIds.includes(item.id);
      label.append(checkbox, document.createTextNode(item.label));
      tools.appendChild(label);
    }
    form.appendChild(tools);

    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = "Запази контекста";
    form.appendChild(submit);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const now = new Date().toISOString();
      const parsedResources = resources.value.split(/\r?\n/u).map((line) => {
        const separator = line.indexOf("|");
        return separator >= 0
          ? {
              label: line.slice(0, separator),
              url: line.slice(separator + 1),
            }
          : { label: "Ресурс", url: line };
      });
      project.objective = cleanText(objective.value, 600);
      project.status = status.value;
      project.decisions = normalizeProjectDecisions(
        decisions.value
          .split(/\r?\n/u)
          .map((text) => ({ text, createdAt: now })),
      );
      project.resources = normalizeProjectResources(parsedResources);
      project.toolIds = [...tools.querySelectorAll("input:checked")].map(
        (checkbox) => checkbox.value,
      );
      project.updatedAt = now;
      saveState();
      managerNotice = `Контекстът на „${project.name}“ е обновен.`;
      renderMode();
      openManager();
    });
    parent.appendChild(form);
  }

  function createAgentForm(parent) {
    const form = document.createElement("form");
    form.className = "work-manager-form";
    addText(form, "label", "Име на режима").htmlFor = "newWorkAgentName";
    const name = document.createElement("input");
    name.id = "newWorkAgentName";
    name.maxLength = 50;
    name.required = true;
    form.appendChild(name);
    addText(form, "label", "Роля").htmlFor = "newWorkAgentRole";
    const role = document.createElement("select");
    role.id = "newWorkAgentRole";
    for (const [id, label] of Object.entries(ROLE_LABELS)) {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = label;
      role.appendChild(option);
    }
    form.appendChild(role);
    addText(form, "label", "Модел").htmlFor = "newWorkAgentModel";
    const model = document.createElement("select");
    model.id = "newWorkAgentModel";
    for (const [id, label] of Object.entries(MODEL_OPTIONS)) {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = label;
      model.appendChild(option);
    }
    form.appendChild(model);
    addText(form, "label", "Допълнителен фокус").htmlFor =
      "newWorkAgentPurpose";
    const purpose = document.createElement("textarea");
    purpose.id = "newWorkAgentPurpose";
    purpose.maxLength = 400;
    purpose.required = true;
    form.appendChild(purpose);
    addText(form, "label", "Изпълнител").htmlFor = "newWorkAgentEngine";
    const engine = document.createElement("select");
    engine.id = "newWorkAgentEngine";
    for (const [id, label] of Object.entries(ENGINE_OPTIONS)) {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = label;
      engine.appendChild(option);
    }
    form.appendChild(engine);
    addText(form, "label", "Любимец на агента").htmlFor = "newWorkAgentPet";
    const pet = document.createElement("select");
    pet.id = "newWorkAgentPet";
    for (const item of PETS) {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = `${item.symbol} ${item.label}`;
      pet.appendChild(option);
    }
    form.appendChild(pet);
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = "Създай и избери режима";
    form.appendChild(submit);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const agent = {
        id: createId("agent"),
        name: cleanText(name.value, 50),
        role: Object.hasOwn(ROLE_LABELS, role.value) ? role.value : "general",
        model: Object.hasOwn(MODEL_OPTIONS, model.value) ? model.value : "auto",
        purpose: cleanText(purpose.value, 400),
        engine: Object.hasOwn(ENGINE_OPTIONS, engine.value)
          ? engine.value
          : "ai-core",
        petId: PETS.some((item) => item.id === pet.value) ? pet.value : "robot",
      };
      if (!agent.name) return;
      const previousActiveAgentId = workState.activeAgentId;
      workState.agents.unshift(agent);
      workState.activeAgentId = agent.id;
      workState.petId = agent.petId;
      if (!saveState()) {
        workState.agents = workState.agents.filter(
          (item) => item.id !== agent.id,
        );
        workState.activeAgentId = previousActiveAgentId;
        managerNotice =
          "Режимът не е запазен. Провери дали браузърът позволява съхранение на данни и опитай отново.";
        openManager();
        return;
      }
      managerNotice = `Режимът „${agent.name}“ е създаден и избран.`;
      renderMode();
      openManager();
    });
    parent.appendChild(form);
  }

  function createEditAgentForm(parent, agent) {
    const form = document.createElement("form");
    form.className = "work-manager-form work-agent-edit-form";
    addText(form, "h4", `Редактиране: ${agent.name}`);
    addText(form, "label", "Име на режима").htmlFor = "editWorkAgentName";
    const name = document.createElement("input");
    name.id = "editWorkAgentName";
    name.maxLength = 50;
    name.required = true;
    name.value = agent.name;
    form.appendChild(name);
    addText(form, "label", "Роля").htmlFor = "editWorkAgentRole";
    const role = document.createElement("select");
    role.id = "editWorkAgentRole";
    for (const [id, label] of Object.entries(ROLE_LABELS)) {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = label;
      role.appendChild(option);
    }
    role.value = agent.role;
    form.appendChild(role);
    addText(form, "label", "Модел").htmlFor = "editWorkAgentModel";
    const model = document.createElement("select");
    model.id = "editWorkAgentModel";
    for (const [id, label] of Object.entries(MODEL_OPTIONS)) {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = label;
      model.appendChild(option);
    }
    model.value = agent.model;
    form.appendChild(model);
    addText(form, "label", "Допълнителен фокус").htmlFor =
      "editWorkAgentPurpose";
    const purpose = document.createElement("textarea");
    purpose.id = "editWorkAgentPurpose";
    purpose.maxLength = 400;
    purpose.required = true;
    purpose.value = agent.purpose;
    form.appendChild(purpose);
    addText(form, "label", "Изпълнител").htmlFor = "editWorkAgentEngine";
    const engine = document.createElement("select");
    engine.id = "editWorkAgentEngine";
    for (const [id, label] of Object.entries(ENGINE_OPTIONS)) {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = label;
      engine.appendChild(option);
    }
    engine.value = agent.engine;
    form.appendChild(engine);
    addText(form, "label", "Любимец на агента").htmlFor = "editWorkAgentPet";
    const pet = document.createElement("select");
    pet.id = "editWorkAgentPet";
    for (const item of PETS) {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = `${item.symbol} ${item.label}`;
      pet.appendChild(option);
    }
    pet.value = agent.petId;
    form.appendChild(pet);

    const actions = document.createElement("div");
    actions.className = "work-form-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "work-form-cancel";
    cancel.textContent = "Отказ";
    cancel.addEventListener("click", () => {
      editingAgentId = null;
      openManager();
    });
    actions.appendChild(cancel);
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = "Запази агента";
    actions.appendChild(submit);
    form.appendChild(actions);

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const next = {
        name: cleanText(name.value, 50),
        role: Object.hasOwn(ROLE_LABELS, role.value) ? role.value : "general",
        model: Object.hasOwn(MODEL_OPTIONS, model.value) ? model.value : "auto",
        purpose: cleanText(purpose.value, 400),
        engine: Object.hasOwn(ENGINE_OPTIONS, engine.value)
          ? engine.value
          : "ai-core",
        petId: PETS.some((item) => item.id === pet.value) ? pet.value : "robot",
      };
      if (!next.name || !next.purpose) return;
      const previous = { ...agent };
      Object.assign(agent, next);
      workState.activeAgentId = agent.id;
      workState.petId = agent.petId;
      if (!saveState()) {
        Object.assign(agent, previous);
        managerNotice =
          "Промените по агента не са запазени. Провери дали браузърът позволява съхранение на данни и опитай отново.";
        openManager();
        return;
      }
      editingAgentId = null;
      managerNotice = `Режимът „${agent.name}“ е обновен и избран.`;
      renderMode();
      openManager();
    });
    parent.appendChild(form);
  }

  function section(parent, title) {
    const container = document.createElement("section");
    container.className = "work-manager-section";
    addText(container, "h3", title);
    parent.appendChild(container);
    return container;
  }

  function openPetManager() {
    closeOtherPanels();
    elements.drawerTitle.textContent = "Избери любимец";
    elements.drawerBody.replaceChildren();
    addText(
      elements.drawerBody,
      "p",
      "Избери кой любимец да те придружава в AI CORE.",
      "work-manager-intro",
    );
    renderPetChoices(elements.drawerBody, openPetManager);
    elements.drawer.hidden = false;
    elements.drawerBackdrop.hidden = false;
  }

  function openManager() {
    closeOtherPanels();
    elements.drawerTitle.textContent = "Проекти и работни режими";
    elements.drawerBody.replaceChildren();
    addText(
      elements.drawerBody,
      "p",
      "Избери проект и ясен работен режим. AI CORE използва контекста, показва напредъка и спира преди рискови действия.",
      "work-manager-intro",
    );
    addText(
      elements.drawerBody,
      "p",
      !storageAvailable || syncStatus === "error"
        ? "Браузърът блокира запазването. Данните не са изчистени нарочно — разреши съхранението и опитай отново."
        : syncStatus === "synced"
          ? "Проектите, режимите и задачите са запазени в защитения ти профил."
          : "Работиш в резервен режим на този браузър. Промените ще се синхронизират при възстановяване на връзката.",
      "work-storage-note",
    );
    if (managerNotice) {
      addText(
        elements.drawerBody,
        "p",
        managerNotice,
        syncStatus === "error" ? "work-save-error" : "work-save-notice",
      );
    }

    const projects = section(elements.drawerBody, "Проекти");
    renderProjectChoices(projects);
    renderProjectContextForm(projects);
    createProjectForm(projects);

    const agents = section(elements.drawerBody, "Работни режими");
    renderAgentChoices(agents);
    const editingAgent = workState.agents.find(
      (agent) => agent.id === editingAgentId,
    );
    const advanced = document.createElement("details");
    advanced.className = "work-advanced-settings";
    advanced.open = Boolean(editingAgent);
    addText(advanced, "summary", "Разширени настройки на режимите");
    if (editingAgent) createEditAgentForm(advanced, editingAgent);
    else createAgentForm(advanced);
    agents.appendChild(advanced);

    const pets = section(elements.drawerBody, "Личен любимец");
    renderPetChoices(pets);

    const activity = section(elements.drawerBody, "Последни задачи");
    renderActivities(activity);

    elements.drawer.hidden = false;
    elements.drawerBackdrop.hidden = false;
  }

  function getRequestPayload() {
    if (workState?.mode !== "work") return { mode: "chat" };
    const project = activeProject();
    const agent = activeAgent();
    return {
      mode: "work",
      workContext: {
        project: {
          id: project?.id || "",
          name: project?.name || "",
          objective: project?.objective || "",
          run: project?.run || null,
          decisions: project?.decisions || [],
          resources: project?.resources || [],
          toolIds: project?.toolIds || [],
          conversationIds: project?.conversationIds || [],
        },
        agent: {
          name: agent?.name || "AI CORE",
          role: agent?.role || "general",
          model: agent?.model || "auto",
          purpose: agent?.purpose || "",
          engine: agent?.engine || "ai-core",
          petId: agent?.petId || "robot",
        },
      },
    };
  }

  function onTask(task) {
    if (!workState || workState.mode !== "work") return;
    recordActivity(task);
    if (task?.status === "waiting_confirmation") {
      setPetState("needs-input");
    } else if (task?.status === "failed" || task?.status === "partial") {
      setPetState("blocked");
    } else if (task?.status === "completed") {
      setPetState("ready");
    } else {
      setPetState("running");
    }
  }

  function onDone(data) {
    if (!workState || workState.mode !== "work") return;
    recordActivity(data?.task);
    const run = normalizeProjectRun(data?.projectRun);
    const projectId = cleanText(data?.projectRun?.projectId, 80);
    const project = workState.projects.find(
      (item) => item.id === (projectId || workState.activeProjectId),
    );
    if (run && project) {
      project.run = run;
      project.updatedAt = run.updatedAt || new Date().toISOString();
      project.status =
        run.status === "blocked"
          ? "blocked"
          : run.needsUserDecision
            ? "needs-input"
            : "ready";
      saveState();
    }
    if (project) {
      const conversationId = currentConversationId();
      if (conversationId && !project.conversationIds.includes(conversationId)) {
        project.conversationIds.unshift(conversationId);
        project.conversationIds = project.conversationIds.slice(0, 50);
        project.updatedAt = new Date().toISOString();
        saveState();
      }
    }
    const status = data?.task?.status;
    if (run?.needsUserDecision) setPetState("needs-input");
    else if (run?.status === "blocked") setPetState("blocked");
    else if (status === "waiting_confirmation") setPetState("needs-input");
    else if (status === "failed" || status === "partial")
      setPetState("blocked");
    else setPetState("ready");
  }

  function init(user) {
    const identity = cleanText(user?.id, 100) || cleanText(user?.role, 20);
    storageKey = `synchronWorkMode:${identity || "anonymous"}`;
    workState = loadState();

    elements.chatModeBtn?.addEventListener("click", () => setMode("chat"));
    elements.workModeToolbarBtn?.addEventListener("click", () =>
      setMode("work"),
    );
    elements.workModeBtn?.addEventListener("click", () => setMode("work"));
    elements.workPetBtn?.addEventListener("click", openPetManager);
    elements.workContextBtn?.addEventListener("click", openManager);
    elements.commandBar?.addEventListener("click", (event) => {
      const command = event.target.closest("[data-command]")?.dataset.command;
      if (command === "work") setMode("work");
      if (command === "chat") setMode("chat");
    });
    renderMode();
    void syncRemoteState();
  }

  globalThis.SynchronWorkMode = Object.freeze({
    getRequestPayload,
    init,
    onDone,
    onError: () => workState?.mode === "work" && setPetState("blocked"),
    onTask,
    openManager,
    openPetManager,
    setBusy: (busy) => {
      if (busy && workState?.mode === "work") setPetState("running");
    },
  });
})();
