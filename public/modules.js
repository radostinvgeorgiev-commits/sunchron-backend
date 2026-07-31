const synchronModules = [
  {
    id: "chat",
    name: "Разговор с AI",
    description: "Основен разговор с личната AI операционна система",
    status: "Основна функция",
    action: "chat",
    prompt: "Продължаваме нормален разговор.",
  },
  {
    id: "memory",
    name: "Памет",
    description: "Личен и проектен контекст под твой контрол",
    status: "Основна функция",
    action: "memory",
  },
  {
    id: "images",
    name: "Снимки",
    description: "Качване и анализ на изображение",
    status: "Инструмент",
    action: "images",
  },
  {
    id: "calendar",
    name: "Google Calendar",
    description: "Преглед на график след свързване на Google",
    status: "Изисква Google",
    action: "calendar",
  },
  {
    id: "health",
    name: "Здраве",
    description: "Здравен дневник, въпроси и проследяване на показатели",
    status: "AI област",
    action: "prompt",
    prompt:
      "Отвори работната област „Здраве“. Помогни ми да запиша или прегледам здравни данни. Не поставяй диагноза и ме попитай само какво искам да направя сега.",
  },
  {
    id: "fitness",
    name: "Спорт и хранене",
    description: "Активност, тренировки и хранителен режим",
    status: "AI област",
    action: "prompt",
    prompt:
      "Отвори работната област „Спорт и хранене“. Използвай наличната ми памет и ме попитай дали искам тренировка, хранителен план или запис на резултат.",
  },
  {
    id: "business",
    name: "Бизнес",
    description: "Задачи, анализи и оперативна помощ за обектите",
    status: "AI област",
    action: "prompt",
    prompt:
      "Отвори работната област „Бизнес“. Използвай контекста за моите обекти и ме попитай коя е текущата бизнес задача.",
  },
  {
    id: "travel",
    name: "Пътувания и резервации",
    description: "Маршрути, места и подготовка на резервации",
    status: "AI област",
    action: "prompt",
    prompt:
      "Отвори работната област „Пътувания и резервации“. Помогни ми с актуално търсене, маршрут или сравнение. Не прави резервация без изрично потвърждение.",
  },
  {
    id: "marketing",
    name: "Реклама и социални мрежи",
    description: "Идеи, текстове и планове за кампании",
    status: "AI област",
    action: "prompt",
    prompt:
      "Отвори работната област „Реклама и социални мрежи“. Помогни ми да подготвя съдържание или кампания. Не публикувай нищо без изрично потвърждение.",
  },
  {
    id: "documents",
    name: "Документи и Google Drive",
    description: "Четене и анализ на разрешени файлове",
    status: "Инструмент",
    action: "drive",
  },
  {
    id: "tasks",
    name: "Задачи и напомняния",
    description: "Защитени напомняния в Google Calendar",
    status: "Изисква Google",
    action: "prompt",
    prompt: "Напомни ми: Заглавие | ГГГГ-ММ-ДД ЧЧ:ММ | 30 минути преди",
  },
  {
    id: "learning",
    name: "Обучение",
    description: "Учебни планове, обяснения и работа с материали",
    status: "AI област",
    action: "prompt",
    prompt:
      "Отвори работната област „Обучение“. Попитай ме какво искам да науча или кой материал да разгледаме.",
  },
];

function moduleCard(module) {
  const connection = module.status === "Изисква Google";
  return `
        <button class="permission-card module-card" type="button"
            data-module-action="${module.action}" data-module-id="${module.id}">
            <div>
                <strong>${module.name}</strong>
                <p>${module.description}</p>
            </div>
            <span class="permission-badge ${connection ? "confirm" : "allow"}">
                ${module.status}
            </span>
        </button>`;
}

function renderSynchronModules() {
  const list = document.querySelector("[data-module-list]");
  if (!list) return;
  list.innerHTML = synchronModules.map(moduleCard).join("");
}

function openPrompt(module) {
  const input = document.getElementById("chatInput");
  document.getElementById("closeDataDrawerBtn")?.click();
  if (!input) return;
  input.value = module.prompt || "";
  input.focus();
}

function activateSynchronModule(module) {
  if (!module) return;
  if (module.action === "memory") {
    document.getElementById("memoryBtn")?.click();
    return;
  }
  if (module.action === "images") {
    document.getElementById("closeDataDrawerBtn")?.click();
    document.getElementById("imageInput")?.click();
    return;
  }
  if (module.action === "calendar") {
    document.getElementById("closeDataDrawerBtn")?.click();
    document.getElementById("googleCalendarBtn")?.click();
    return;
  }
  if (module.action === "drive") {
    document.getElementById("closeDataDrawerBtn")?.click();
    document.getElementById("googleDriveBtn")?.click();
    return;
  }
  openPrompt(module);
}

document.addEventListener("synchron:modules-opened", renderSynchronModules);
document.addEventListener("click", (event) => {
  const card = event.target.closest("[data-module-id]");
  if (!card) return;
  activateSynchronModule(
    synchronModules.find((module) => module.id === card.dataset.moduleId),
  );
});

globalThis.synchronModules = synchronModules;
