(() => {
  const STORAGE_VERSION = 1;
  const PETS = Object.freeze([
    { id: "robot", symbol: "🤖", label: "Робот" },
    { id: "cat", symbol: "🐈", label: "Котка" },
    { id: "owl", symbol: "🦉", label: "Сова" },
    { id: "spark", symbol: "✨", label: "Искра" },
  ]);
  const ROLE_LABELS = Object.freeze({
    general: "Универсален помощник",
    researcher: "Изследовател",
    organizer: "Организатор",
    builder: "Създател на проекти",
  });

  let storageKey = "synchronWorkMode:anonymous";
  let workState = null;

  const elements = {
    chatInput: document.getElementById("chatInput"),
    chatModeBtn: document.getElementById("chatModeBtn"),
    workModeToolbarBtn: document.getElementById("workModeToolbarBtn"),
    workModeBtn: document.getElementById("workModeBtn"),
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
        },
      ],
      agents: [
        {
          id: "synchron-builder",
          name: "SYNCHRON-X",
          role: "builder",
          purpose: "Подготвя реален резултат и показва какво е проверено.",
        },
      ],
    };
  }

  function cleanText(value, maxLength) {
    return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
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
        }))
      : fallback.projects;
    const agents = Array.isArray(value.agents)
      ? value.agents.slice(0, 12).map((agent) => ({
          id: cleanText(agent?.id, 80) || createId("agent"),
          name: cleanText(agent?.name, 50) || "Личен агент",
          role: Object.hasOwn(ROLE_LABELS, agent?.role)
            ? agent.role
            : "general",
          purpose: cleanText(agent?.purpose, 400),
        }))
      : fallback.agents;

    if (!projects.length) projects.push(...fallback.projects);
    if (!agents.length) agents.push(...fallback.agents);

    return {
      version: STORAGE_VERSION,
      mode: value.mode === "work" ? "work" : "chat",
      activeProjectId: projects.some(
        (project) => project.id === value.activeProjectId,
      )
        ? value.activeProjectId
        : projects[0].id,
      activeAgentId: agents.some((agent) => agent.id === value.activeAgentId)
        ? value.activeAgentId
        : agents[0].id,
      petId: PETS.some((pet) => pet.id === value.petId)
        ? value.petId
        : fallback.petId,
      petState: ["ready", "running", "needs-input", "blocked"].includes(
        value.petState,
      )
        ? value.petState
        : "ready",
      projects,
      agents,
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

  function saveState() {
    try {
      localStorage.setItem(storageKey, JSON.stringify(workState));
    } catch {
      // The UI remains usable even when private browsing blocks storage.
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
      : "Пиши на SYNCHRON-X";
    const project = activeProject();
    const agent = activeAgent();
    elements.projectLabel.textContent = isWork
      ? project?.name || "Без активен проект"
      : "Разговор";
    elements.agentLabel.textContent = agent?.name || "SYNCHRON-X";
    renderPet();
    activateMobileCommand(isWork ? "work" : "chat");
  }

  function renderPet() {
    const pet = selectedPet();
    elements.pet.textContent = pet.symbol;
    elements.pet.dataset.petState = workState.petState;
    const statusLabels = {
      running: "Работи по задачата",
      "needs-input": "Чака твое решение",
      ready: "Готово за преглед",
      blocked: "Задачата е блокирана",
    };
    elements.workContextBtn.title = `${pet.label}: ${statusLabels[workState.petState]}`;
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
      list.appendChild(button);
    }
    parent.appendChild(list);
  }

  function renderAgentChoices(parent) {
    const list = document.createElement("div");
    list.className = "work-choice-list";
    for (const agent of workState.agents) {
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
      addText(
        button,
        "small",
        `${ROLE_LABELS[agent.role]}${agent.purpose ? ` · ${agent.purpose}` : ""}`,
      );
      list.appendChild(button);
    }
    parent.appendChild(list);
  }

  function renderPetChoices(parent) {
    const grid = document.createElement("div");
    grid.className = "pet-choice-grid";
    for (const pet of PETS) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "pet-choice";
      button.classList.toggle("active", pet.id === workState.petId);
      button.addEventListener("click", () => {
        workState.petId = pet.id;
        saveState();
        renderPet();
        openManager();
      });
      addText(button, "span", pet.symbol);
      addText(button, "small", pet.label);
      grid.appendChild(button);
    }
    parent.appendChild(grid);
    addText(
      parent,
      "p",
      "Любимецът показва: работи, чака решение, готов е или е блокиран. Той не променя правата на AI.",
      "work-pet-status",
    );
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
      };
      if (!project.name) return;
      workState.projects.unshift(project);
      workState.activeProjectId = project.id;
      saveState();
      renderMode();
      openManager();
    });
    parent.appendChild(form);
  }

  function createAgentForm(parent) {
    const form = document.createElement("form");
    form.className = "work-manager-form";
    addText(form, "label", "Име на агента").htmlFor = "newWorkAgentName";
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
    addText(form, "label", "Допълнителен фокус").htmlFor =
      "newWorkAgentPurpose";
    const purpose = document.createElement("textarea");
    purpose.id = "newWorkAgentPurpose";
    purpose.maxLength = 400;
    form.appendChild(purpose);
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = "Създай и избери агента";
    form.appendChild(submit);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const agent = {
        id: createId("agent"),
        name: cleanText(name.value, 50),
        role: Object.hasOwn(ROLE_LABELS, role.value) ? role.value : "general",
        purpose: cleanText(purpose.value, 400),
      };
      if (!agent.name) return;
      workState.agents.unshift(agent);
      workState.activeAgentId = agent.id;
      saveState();
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
    elements.drawerTitle.textContent = "Работа, агенти и любимец";
    elements.drawerBody.replaceChildren();
    addText(
      elements.drawerBody,
      "p",
      "Избери проект и личен агент. В режим Работа SYNCHRON-X използва този контекст, показва напредъка и спира преди рискови действия.",
      "work-manager-intro",
    );
    addText(
      elements.drawerBody,
      "p",
      "Първата тестова версия пази тези настройки само в този браузър. Разговорите и постоянната памет продължават да се пазят от сървъра.",
      "work-storage-note",
    );

    const projects = section(elements.drawerBody, "Проекти");
    renderProjectChoices(projects);
    createProjectForm(projects);

    const agents = section(elements.drawerBody, "Лични агенти");
    renderAgentChoices(agents);
    createAgentForm(agents);

    const pets = section(elements.drawerBody, "Домашен любимец");
    renderPetChoices(pets);

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
          name: project?.name || "",
          objective: project?.objective || "",
        },
        agent: {
          name: agent?.name || "SYNCHRON-X",
          role: agent?.role || "general",
          purpose: agent?.purpose || "",
        },
      },
    };
  }

  function onTask(task) {
    if (!workState || workState.mode !== "work") return;
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
    const status = data?.task?.status;
    if (status === "waiting_confirmation") setPetState("needs-input");
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
    elements.workContextBtn?.addEventListener("click", openManager);
    elements.commandBar?.addEventListener("click", (event) => {
      const command = event.target.closest("[data-command]")?.dataset.command;
      if (command === "work") setMode("work");
      if (command === "chat") setMode("chat");
    });
    renderMode();
  }

  globalThis.SynchronWorkMode = Object.freeze({
    getRequestPayload,
    init,
    onDone,
    onError: () => workState?.mode === "work" && setPetState("blocked"),
    onTask,
    openManager,
    setBusy: (busy) => {
      if (busy && workState?.mode === "work") setPetState("running");
    },
  });
})();
