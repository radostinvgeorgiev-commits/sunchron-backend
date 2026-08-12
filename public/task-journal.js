(() => {
  const STORAGE_KEY = "synchronTaskJournalV1";
  const ROADMAP_VERSION_KEY = "synchronTaskJournalRoadmapVersion";
  const ROADMAP_VERSION = 3;
  const STATUS_ORDER = ["now", "waiting", "done"];
  const STATUS_META = Object.freeze({
    now: {
      label: "Сега",
      description: "Работим по тези задачи",
      icon: "fa-solid fa-bolt",
    },
    waiting: {
      label: "Чака",
      description: "Следващи или блокирани задачи",
      icon: "fa-regular fa-clock",
    },
    done: {
      label: "Завършено",
      description: "Проверени и приключени задачи",
      icon: "fa-solid fa-check",
    },
  });

  const DEFAULT_TASKS = Object.freeze([
    {
      id: "autonomous-delivery",
      title: "Автономно безопасно развитие",
      detail:
        "Асистентът работи без Copilot чрез отделен клон, тестове, PR, CI и точна production проверка.",
      status: "now",
      priority: "Текущ режим",
    },
    {
      id: "agent-consistency",
      title: "Краен owner тест на свързаните услуги",
      detail:
        "ChatGPT MCP, GitHub и Google чакат проверка през активна owner сесия, без заобикаляне на входа.",
      status: "waiting",
      priority: "Изисква owner вход",
    },
    {
      id: "firestore-backup",
      title: "Firestore managed backup проверка",
      detail:
        "Паметта и operational state са в Firestore; backup политиката се управлява от Google Cloud без legacy storage adapter.",
      status: "done",
      priority: "Проверено",
    },
    {
      id: "memory-real-data",
      title: "Постоянна памет и изолиран acceptance тест",
      detail:
        "Production проверката минава 9 от 9 стъпки, пази изолацията и оставя реалната памет непроменена.",
      status: "done",
      priority: "Проверено",
    },
    {
      id: "tester-registration",
      title: "Регистрация и вход с изолиран тестов профил",
      detail:
        "Следващата безопасна проверка е реална регистрация, вход и отделно потребителско пространство без достъп до owner данните.",
      status: "now",
      priority: "Следваща проверка",
    },
    {
      id: "avatar-profile",
      title: "Личен AI аватар и контекст",
      detail:
        "Интерфейсът използва профил, проектен контекст, контролираната памет и български гласов вход/изход.",
      status: "done",
      priority: "Проверено",
    },
    {
      id: "first-integration",
      title: "Реални интеграции през Capability Engine",
      detail:
        "GitHub, Google, потребителските профили, инфраструктурата, web search и MCP имат изпълними защитени пътища.",
      status: "done",
      priority: "Проверено",
    },
    {
      id: "site-chat-core",
      title: "Сайт, AI разговор и постоянна памет",
      detail:
        "Живият чат използва AI ядрото, а състоянието на паметта е проверено.",
      status: "done",
      priority: "Завършено",
    },
    {
      id: "accessible-font",
      title: "Регулируем едър шрифт",
      detail: "Размерът се управлява с – / + и се запазва автоматично.",
      status: "done",
      priority: "Завършено",
    },
    {
      id: "github-bridge",
      title: "GitHub read, PR, CI и production delivery",
      detail:
        "Промените минават през точен Git tree, независими тестове и production smoke. Copilot не се използва.",
      status: "done",
      priority: "Завършено",
    },
    {
      id: "calendar-reminders",
      title: "Защитени Google Calendar напомняния",
      detail:
        "Напомнянето се подготвя в точен формат и се записва само след еднократно потвърждение.",
      status: "done",
      priority: "Завършено",
    },
  ]);
  const MANAGED_TASK_IDS = new Set(DEFAULT_TASKS.map((task) => task.id));

  const button = document.getElementById("focusBtn");
  const drawer = document.getElementById("dataDrawer");
  const backdrop = document.getElementById("drawerBackdrop");
  const title = document.getElementById("dataDrawerTitle");
  const body = document.getElementById("dataDrawerBody");
  const sidebar = document.getElementById("sidebar");
  if (!button || !drawer || !backdrop || !title || !body || !sidebar) return;

  let tasks = loadTasks();

  function cloneDefaults() {
    return DEFAULT_TASKS.map((task) => ({ ...task }));
  }

  function persistTasks(nextTasks) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(nextTasks));
    localStorage.setItem(ROADMAP_VERSION_KEY, String(ROADMAP_VERSION));
  }

  function migrateRoadmapTasks(storedTasks) {
    const personalTasks = storedTasks.filter(
      (task) => !MANAGED_TASK_IDS.has(task.id),
    );
    return [...personalTasks, ...cloneDefaults()];
  }

  function loadTasks() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (!Array.isArray(parsed)) {
        const defaults = cloneDefaults();
        persistTasks(defaults);
        return defaults;
      }
      const valid = parsed.filter(
        (task) =>
          task &&
          typeof task.id === "string" &&
          typeof task.title === "string" &&
          STATUS_ORDER.includes(task.status),
      );
      const storedVersion = Number(
        localStorage.getItem(ROADMAP_VERSION_KEY) || 0,
      );
      if (storedVersion < ROADMAP_VERSION) {
        const migrated = migrateRoadmapTasks(valid);
        persistTasks(migrated);
        return migrated;
      }
      return valid.length ? valid : cloneDefaults();
    } catch {
      return cloneDefaults();
    }
  }

  function saveTasks() {
    persistTasks(tasks);
  }

  function createElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function taskCount(status) {
    return tasks.filter((task) => task.status === status).length;
  }

  function nextStatus(status) {
    if (status === "now") return "waiting";
    if (status === "waiting") return "done";
    return "now";
  }

  function nextStatusLabel(status) {
    if (status === "now") return "Премести в „Чака“";
    if (status === "waiting") return "Отбележи като завършено";
    return "Върни в „Сега“";
  }

  function createTaskCard(task) {
    const card = createElement("article", `task-card task-${task.status}`);
    card.dataset.taskId = task.id;

    const content = createElement("div", "task-card-content");
    const meta = createElement(
      "span",
      "task-priority",
      task.priority || "Задача",
    );
    const heading = createElement("h4", "", task.title);
    const detail = createElement(
      "p",
      "",
      task.detail || "Без допълнително описание.",
    );
    content.append(meta, heading, detail);

    const actions = createElement("div", "task-card-actions");
    const moveButton = createElement(
      "button",
      "task-move-btn",
      nextStatusLabel(task.status),
    );
    moveButton.type = "button";
    moveButton.dataset.taskMove = task.id;
    actions.appendChild(moveButton);

    if (!DEFAULT_TASKS.some((item) => item.id === task.id)) {
      const removeButton = createElement(
        "button",
        "task-remove-btn",
        "Премахни",
      );
      removeButton.type = "button";
      removeButton.dataset.taskRemove = task.id;
      actions.appendChild(removeButton);
    }

    card.append(content, actions);
    return card;
  }

  function createColumn(status) {
    const meta = STATUS_META[status];
    const section = createElement(
      "section",
      `task-column task-column-${status}`,
    );
    section.dataset.taskColumn = status;

    const header = createElement("header", "task-column-header");
    const icon = createElement("span", "task-column-icon");
    icon.innerHTML = `<i class="${meta.icon}" aria-hidden="true"></i>`;
    const headingWrap = createElement("div");
    const heading = createElement("h3", "", meta.label);
    const description = createElement("p", "", meta.description);
    headingWrap.append(heading, description);
    const count = createElement(
      "span",
      "task-count",
      String(taskCount(status)),
    );
    count.setAttribute("aria-label", `${taskCount(status)} задачи`);
    header.append(icon, headingWrap, count);
    section.appendChild(header);

    const list = createElement("div", "task-list");
    const statusTasks = tasks.filter((task) => task.status === status);
    if (!statusTasks.length) {
      list.appendChild(
        createElement("p", "task-empty", "В тази група няма задачи."),
      );
    } else {
      statusTasks.forEach((task) => list.appendChild(createTaskCard(task)));
    }
    section.appendChild(list);
    return section;
  }

  function renderJournal() {
    title.textContent = "Дневник на задачите";
    body.replaceChildren();

    const summary = createElement("section", "task-journal-summary");
    const summaryText = createElement("div");
    summaryText.append(
      createElement("span", "task-journal-kicker", "Текущ ред на работа"),
      createElement("h2", "", "Една ясна задача наведнъж"),
      createElement(
        "p",
        "",
        "Първо стабилен разговор и памет. После личен аватар и реални интеграции.",
      ),
    );
    const progress = createElement("div", "task-progress");
    progress.append(
      createElement("strong", "", `${taskCount("done")} завършени`),
      createElement(
        "span",
        "",
        `${taskCount("now")} активни · ${taskCount("waiting")} чакат`,
      ),
    );
    summary.append(summaryText, progress);
    body.appendChild(summary);

    const form = createElement("form", "task-add-form");
    form.dataset.taskAddForm = "";
    const label = createElement("label", "", "Добави нова задача");
    label.htmlFor = "taskJournalInput";
    const row = createElement("div", "task-add-row");
    const input = createElement("input");
    input.id = "taskJournalInput";
    input.name = "task";
    input.type = "text";
    input.maxLength = 160;
    input.placeholder = "Напиши кратка и конкретна задача";
    input.autocomplete = "off";
    const addButton = createElement("button", "", "Добави в „Сега“");
    addButton.type = "submit";
    row.append(input, addButton);
    form.append(label, row);
    body.appendChild(form);

    const board = createElement("div", "task-board");
    STATUS_ORDER.forEach((status) => board.appendChild(createColumn(status)));
    body.appendChild(board);

    const note = createElement(
      "p",
      "task-storage-note",
      "Промените се запазват автоматично на това устройство.",
    );
    body.appendChild(note);
  }

  function openJournal(event) {
    event?.preventDefault();
    event?.stopImmediatePropagation();
    drawer.hidden = false;
    backdrop.hidden = false;
    sidebar.classList.remove("mobile-visible");
    renderJournal();
  }

  function addTask(form) {
    const input = form.elements.task;
    const taskTitle = input.value.trim();
    if (!taskTitle) {
      input.focus();
      return;
    }
    tasks.unshift({
      id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title: taskTitle,
      detail: "Добавена от Дневника на задачите.",
      status: "now",
      priority: "Нова задача",
    });
    saveTasks();
    renderJournal();
  }

  body.addEventListener("submit", (event) => {
    const form = event.target.closest("[data-task-add-form]");
    if (!form) return;
    event.preventDefault();
    addTask(form);
  });

  body.addEventListener("click", (event) => {
    const moveButton = event.target.closest("[data-task-move]");
    if (moveButton) {
      const task = tasks.find(
        (item) => item.id === moveButton.dataset.taskMove,
      );
      if (!task) return;
      task.status = nextStatus(task.status);
      task.priority = STATUS_META[task.status].label;
      saveTasks();
      renderJournal();
      return;
    }

    const removeButton = event.target.closest("[data-task-remove]");
    if (!removeButton) return;
    tasks = tasks.filter((item) => item.id !== removeButton.dataset.taskRemove);
    saveTasks();
    renderJournal();
  });

  button.addEventListener("click", openJournal, true);

  globalThis.SynchronTaskJournal = Object.freeze({
    open: openJournal,
    statuses: STATUS_ORDER,
    storageKey: STORAGE_KEY,
    roadmapVersion: ROADMAP_VERSION,
  });
})();
