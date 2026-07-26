const synchronModules = [
    {
        id: 'chat',
        name: 'Разговор с AI',
        description: 'Основен разговор с личния аватар',
        status: 'Работи',
        action: 'chat',
        prompt: 'Продължаваме нормален разговор.'
    },
    {
        id: 'memory',
        name: 'Памет',
        description: 'Личен и проектен контекст под твой контрол',
        status: 'Работи',
        action: 'memory'
    },
    {
        id: 'images',
        name: 'Снимки',
        description: 'Качване и анализ на изображение',
        status: 'Работи',
        action: 'images'
    },
    {
        id: 'calendar',
        name: 'Google Calendar',
        description: 'Преглед на график след свързване на Google',
        status: 'Готов за свързване',
        action: 'calendar'
    },
    {
        id: 'health',
        name: 'Здраве',
        description: 'Здравен дневник, въпроси и проследяване на показатели',
        status: 'Работи',
        action: 'prompt',
        prompt: 'Отвори модула „Здраве“. Помогни ми да запиша или прегледам здравни данни. Не поставяй диагноза и ме попитай само какво искам да направя сега.'
    },
    {
        id: 'fitness',
        name: 'Спорт и хранене',
        description: 'Активност, тренировки и хранителен режим',
        status: 'Работи',
        action: 'prompt',
        prompt: 'Отвори модула „Спорт и хранене“. Използвай наличната ми памет и ме попитай дали искам тренировка, хранителен план или запис на резултат.'
    },
    {
        id: 'business',
        name: 'Бизнес',
        description: 'Задачи, анализи и оперативна помощ за обектите',
        status: 'Работи',
        action: 'prompt',
        prompt: 'Отвори модула „Бизнес“. Използвай контекста за моите обекти и ме попитай коя е текущата бизнес задача.'
    },
    {
        id: 'travel',
        name: 'Пътувания и резервации',
        description: 'Маршрути, места и подготовка на резервации',
        status: 'Работи',
        action: 'prompt',
        prompt: 'Отвори модула „Пътувания и резервации“. Помогни ми с актуално търсене, маршрут или сравнение. Не прави резервация без изрично потвърждение.'
    },
    {
        id: 'marketing',
        name: 'Реклама и социални мрежи',
        description: 'Идеи, текстове и планове за кампании',
        status: 'Работи',
        action: 'prompt',
        prompt: 'Отвори модула „Реклама и социални мрежи“. Помогни ми да подготвя съдържание или кампания. Не публикувай нищо без изрично потвърждение.'
    },
    {
        id: 'documents',
        name: 'Документи и Google Drive',
        description: 'Четене и анализ на разрешени файлове',
        status: 'Работи',
        action: 'drive'
    },
    {
        id: 'tasks',
        name: 'Задачи и напомняния',
        description: 'Подреждане на задачи и подготовка на напомняния',
        status: 'Работи',
        action: 'prompt',
        prompt: 'Отвори модула „Задачи и напомняния“. Попитай ме каква задача или напомняне искам да добавя. Не създавай външно напомняне без потвърждение.'
    },
    {
        id: 'learning',
        name: 'Обучение',
        description: 'Учебни планове, обяснения и работа с материали',
        status: 'Работи',
        action: 'prompt',
        prompt: 'Отвори модула „Обучение“. Попитай ме какво искам да науча или кой материал да разгледаме.'
    }
];

function moduleCard(module) {
    const connection = module.status === 'Готов за свързване';
    return `
        <button class="permission-card module-card" type="button"
            data-module-action="${module.action}" data-module-id="${module.id}">
            <div>
                <strong>${module.name}</strong>
                <p>${module.description}</p>
            </div>
            <span class="permission-badge ${connection ? 'confirm' : 'allow'}">
                ${module.status}
            </span>
        </button>`;
}

function renderSynchronModules() {
    const list = document.querySelector('[data-module-list]');
    if (!list) return;
    list.innerHTML = synchronModules.map(moduleCard).join('');
}

function openPrompt(module) {
    const input = document.getElementById('chatInput');
    document.getElementById('closeDataDrawerBtn')?.click();
    if (!input) return;
    input.value = module.prompt || '';
    input.focus();
}

function activateSynchronModule(module) {
    if (!module) return;
    if (module.action === 'memory') {
        document.getElementById('memoryBtn')?.click();
        return;
    }
    if (module.action === 'images') {
        document.getElementById('closeDataDrawerBtn')?.click();
        document.getElementById('imageInput')?.click();
        return;
    }
    if (module.action === 'calendar') {
        document.getElementById('closeDataDrawerBtn')?.click();
        document.getElementById('googleCalendarBtn')?.click();
        return;
    }
    if (module.action === 'drive') {
        document.getElementById('closeDataDrawerBtn')?.click();
        document.getElementById('googleDriveBtn')?.click();
        return;
    }
    openPrompt(module);
}

document.addEventListener('synchron:modules-opened', renderSynchronModules);
document.addEventListener('click', (event) => {
    const card = event.target.closest('[data-module-id]');
    if (!card) return;
    activateSynchronModule(
        synchronModules.find((module) => module.id === card.dataset.moduleId)
    );
});

globalThis.synchronModules = synchronModules;
