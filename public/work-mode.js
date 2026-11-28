(() => {
  const text = (value) => globalThis.NovariumLocale?.text?.(value) ?? value;
  const STORAGE_VERSION = 6;
  const WORKSPACE_ENDPOINT = "/api/workspaces";
  const ROLE_LABELS = Object.freeze({
    general: "Универсален помощник",
    researcher: "Изследовател",
    organizer: "Организатор",
    documents: "Документи и поща",
    builder: "Създател на проекти",
    coder: "Код разработчик (Google)",
  });
  const ENGINE_OPTIONS = Object.freeze({
    "novarium": "NovariumAI",
    codex: "Google код · анализ и branch/PR",
  });
  const MODEL_OPTIONS = Object.freeze({
    auto: "Автоматичен · препоръчано",
    "vertex-gemini-2.5-flash": "Vertex Gemini · Google Cloud",
    "vertex-gemma-4-26b": "Vertex Gemma · Google Cloud",
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
      engine: "novarium",
    }),
    Object.freeze({
      id: "research-agent",
      name: "Проучи",
      role: "researcher",
      model: "auto",
      purpose: "Проверява актуални източници и отделя фактите от изводите.",
      engine: "novarium",
    }),
    Object.freeze({
      id: "organizer-agent",
      name: "Организирай",
      role: "organizer",
      model: "auto",
      purpose: "Подрежда задачи и календар, като спира преди външни промени.",
      engine: "novarium",
    }),
    Object.freeze({
      id: "documents-agent",
      name: "Напиши",
      role: "documents",
      model: "auto",
      purpose: "Работи с разрешени файлове, документи и поща.",
      engine: "novarium",
    }),
    Object.freeze({
      id: "codex-agent",
      name: "Код",
      role: "coder",
      model: "auto",
      purpose: "Google подготвя code diff в branch/PR поток след owner потвърждение.",
      engine: "codex",
    }),
  ]);

  let storageKey = "synchronWorkMode:anonymous";
  let workState = null;
  let remoteReady = false;
  let saveTimer = null;
  let syncStatus = "local";
  let localRevision = 0;
  let storageAvailable = true;
  let managerNotice = "";
  let editingAgentId = null;
  let conversationActions = {};
  let conversationBusy = false;
  let remoteWrites = Promise.resolve();

  const elements = {
    chatInput: document.getElementById("chatInput"),
    chatModeBtn: document.getElementById("chatModeBtn"),
    workModeToolbarBtn: document.getElementById("workModeToolbarBtn"),
    workModeBtn: document.getElementById("workModeBtn"),
    workContextBtn: document.getElementById("workContextBtn"),
    projectLabel: document.getElementById("workProjectLabel"),
    agentLabel: document.getElementById("workAgentLabel"),
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
      workStatus: "ready",
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
            : "novarium",
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

    return {
      version: STORAGE_VERSION,
      mode: value.mode === "work" ? "work" : "chat",
      activeProjectId,
      activeAgentId,
      workStatus: ["ready", "running", "needs-input", "blocked"].includes(
        value.workStatus ?? value.petState,
      )
        ? (value.workStatus ?? value.petState)
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
    if (conversationActions.getActiveId)
      return conversationActions.getActiveId();
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

  function persistRemoteState() {
    const snapshot = normalizeState(workState);
    const revision = localRevision;
    remoteWrites = remoteWrites.then(() =>
      writeRemoteState(snapshot, revision),
    );
    return remoteWrites;
  }

  async function writeRemoteState(snapshot, revision) {
    try {
      const payload = await readJson(
        await fetch(WORKSPACE_ENDPOINT, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ state: snapshot }),
          signal: globalThis.AbortSignal?.timeout?.(6_000),
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

  async function flushProjectContext() {
    if (!remoteReady || !hasPendingRemoteSave()) return;
    clearTimeout(saveTimer);
    await persistRemoteState();
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
    elements.chatInput.placeholder = text(isWork
      ? "Какъв резултат да изработим?"
      : "Пиши на NovariumAI");
    const project = activeProject();
    const agent = activeAgent();
    elements.projectLabel.textContent = isWork
      ? project?.name || text("Без активен проект")
      : text("Разговор");
    // Built-in agent names ("Изпълни") are translated; names people gave
    // their own agents stay as written.
    elements.agentLabel.textContent = agent?.name ? text(agent.name) : "NovariumAI";
    activateMobileCommand(isWork ? "work" : "chat");
    // The header model picker shows chat models in "Чат" and the work
    // agent's models in "Работа".
    document.dispatchEvent(new CustomEvent("novarium:mode-changed", { detail: { mode: workState.mode } }));
  }

  function setMode(mode) {
    workState.mode = mode === "work" ? "work" : "chat";
    saveState();
    renderMode();
    elements.sidebar?.classList.remove("mobile-visible");
    if (elements.sidebarBackdrop) elements.sidebarBackdrop.hidden = true;
    elements.chatInput?.focus();
  }

  function selectConversation(sessionId) {
    if (workState?.mode !== "work") return;
    if (activeProject()?.conversationIds.includes(sessionId)) return;
    const project = workState.projects.find(({ conversationIds }) =>
      conversationIds.includes(sessionId),
    );
    if (project) workState.activeProjectId = project.id;
    setMode(project ? "work" : "chat");
  }

  function setWorkStatus(status) {
    const next = ["ready", "running", "needs-input", "blocked"].includes(status)
      ? status
      : "ready";
    workState.workStatus = next;
    const project = activeProject();
    if (project && workState.mode === "work") {
      project.status = next;
      project.updatedAt = new Date().toISOString();
    }
    saveState();
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

  function addConversationToProject(projectId, sessionId) {
    const project = workState.projects.find(({ id }) => id === projectId);
    if (!project || !sessionId || project.conversationIds.includes(sessionId))
      return;
    project.conversationIds = [sessionId, ...project.conversationIds].slice(
      0,
      50,
    );
    project.updatedAt = new Date().toISOString();
    saveState();
  }

  function renderProjectConversations(parent) {
    const project = activeProject();
    if (!project || !conversationActions.open) return;
    const related = section(parent, "Разговори в проекта");
    const controls = document.createElement("div");
    controls.className = "work-project-chat-controls";
    related.appendChild(controls);
    const addButton = (container, label, action) => {
      const button = addText(
        container,
        "button",
        label,
        "work-project-chat-action",
      );
      button.type = "button";
      button.addEventListener("click", () => {
        if (!conversationBusy) void action();
      });
      return button;
    };
    const activeId = currentConversationId();
    const linked = project.conversationIds.includes(activeId);
    addButton(controls, "Задай задача", () => {
      conversationActions.closeDrawer();
      setMode("work");
    });
    addButton(controls, "Нов чат в проекта", async () => {
      conversationActions.closeDrawer();
      setMode("work");
      const id = await conversationActions.create();
      addConversationToProject(project.id, id);
    });
    if (activeId && !linked) {
      addButton(controls, "Свържи текущия чат", () => {
        addConversationToProject(project.id, activeId);
        openManager();
      });
    }

    const titles = new Map(
      (conversationActions.list?.() || []).map(({ sessionId, title }) => [
        sessionId,
        title,
      ]),
    );
    const list = document.createElement("ul");
    list.className = "work-project-chat-list";
    for (const [index, id] of project.conversationIds.entries()) {
      const item = document.createElement("li");
      const title = titles.get(id) || `Свързан разговор ${index + 1}`;
      const open = addButton(item, title, async () => {
        conversationActions.closeDrawer();
        setMode("work");
        await conversationActions.open(id);
      });
      if (id === activeId) open.setAttribute("aria-current", "true");
      const unlink = addButton(item, "Откачи", () => {
        const current = workState.projects.find(({ id }) => id === project.id);
        if (!current) return;
        current.conversationIds = current.conversationIds.filter(
          (itemId) => itemId !== id,
        );
        current.updatedAt = new Date().toISOString();
        saveState();
        openManager();
      });
      unlink.setAttribute("aria-label", `Откачи ${title}`);
      list.appendChild(item);
    }
    if (list.childElementCount) related.appendChild(list);
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
        saveState();
        renderMode();
        openManager();
      });
      addText(button, "strong", agent.name);
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
        saveState();
        renderMode();
        openManager();
      });
      item.appendChild(edit);
      list.appendChild(item);
    }
    parent.appendChild(list);
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
          : "novarium",
      };
      if (!agent.name) return;
      const previousActiveAgentId = workState.activeAgentId;
      workState.agents.unshift(agent);
      workState.activeAgentId = agent.id;
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
          : "novarium",
      };
      if (!next.name || !next.purpose) return;
      const previous = { ...agent };
      Object.assign(agent, next);
      workState.activeAgentId = agent.id;
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

  function openManager() {
    closeOtherPanels();
    elements.drawerTitle.textContent = "Проекти и работни режими";
    elements.drawerBody.replaceChildren();
    addText(
      elements.drawerBody,
      "p",
      "Избери проект и ясен работен режим. NovariumAI използва контекста, показва напредъка и спира преди рискови действия.",
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
    renderProjectConversations(projects);
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
          name: agent?.name || "NovariumAI",
          role: agent?.role || "general",
          model: agent?.model || "auto",
          purpose: agent?.purpose || "",
          engine: agent?.engine || "novarium",
        },
      },
    };
  }

  function onTask(task) {
    if (!workState || workState.mode !== "work") return;
    recordActivity(task);
    if (task?.status === "waiting_confirmation") {
      setWorkStatus("needs-input");
    } else if (task?.status === "failed" || task?.status === "partial") {
      setWorkStatus("blocked");
    } else if (task?.status === "completed") {
      setWorkStatus("ready");
    } else {
      setWorkStatus("running");
    }
  }

  function onDone(data, sent = {}) {
    if (!workState || (sent.mode || workState.mode) !== "work") return;
    recordActivity(data?.task);
    const run = normalizeProjectRun(data?.projectRun);
    const projectId = cleanText(data?.projectRun?.projectId, 80);
    const project = workState.projects.find(
      (item) =>
        item.id ===
        (projectId ||
          sent.projectId ||
          (!sent.sessionId && workState.activeProjectId)),
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
    if (project && data?.conversationPersisted !== false) {
      addConversationToProject(
        project.id,
        sent.sessionId || currentConversationId(),
      );
    }
    const status = data?.task?.status;
    if (run?.needsUserDecision) setWorkStatus("needs-input");
    else if (run?.status === "blocked") setWorkStatus("blocked");
    else if (status === "waiting_confirmation") setWorkStatus("needs-input");
    else if (status === "failed" || status === "partial")
      setWorkStatus("blocked");
    else setWorkStatus("ready");
  }

  function init(user, actions = {}) {
    conversationActions = actions;
    const identity = cleanText(user?.id, 100) || cleanText(user?.role, 20);
    storageKey = `synchronWorkMode:${identity || "anonymous"}`;
    workState = loadState();

    elements.chatModeBtn?.addEventListener("click", () => setMode("chat"));
    elements.workModeToolbarBtn?.addEventListener("click", () =>
      setMode("work"),
    );
    elements.workModeBtn?.addEventListener("click", () => setMode("work"));
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
    mode: () => workState?.mode || "chat",
    agentModel: () => activeAgent()?.model || "auto",
    agentName: () => activeAgent()?.name || "",
    setAgentModel: (id) => {
      const agent = activeAgent();
      if (!agent || !Object.hasOwn(MODEL_OPTIONS, id)) return false;
      agent.model = id;
      saveState();
      renderMode();
      return true;
    },
    flushProjectContext,
    getRequestPayload,
    init,
    onDone,
    onError: () => workState?.mode === "work" && setWorkStatus("blocked"),
    onTask,
    openManager,
    selectConversation,
    setBusy: (busy) => {
      conversationBusy = busy;
      if (workState?.mode !== "work") return;
      if (busy) setWorkStatus("running");
      // A picture or a clip has no answer to end its run: when nothing else
      // set the status, the project is ready again, as after an answer.
      else if (workState.workStatus === "running") setWorkStatus("ready");
    },
  });
})();
