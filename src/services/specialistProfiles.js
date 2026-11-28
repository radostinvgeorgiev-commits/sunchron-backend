// One project memory for every specialist. The engine is the same as the
// writer's book memory (facts kept only with the person's "да", a check of
// new work against them with word-for-word quotes, a draft from a plan,
// files in and out); each specialist only names things in its own words.
export const SPECIALIST_PROFILES = Object.freeze({
  writer: {
    project: "Книга",
    unit: "Глава",
    memory: "Паметта на книгата",
    kinds: { character: "Герой", place: "Място", rule: "Правило", event: "Събитие" },
    expert: "писател и редактор на книга",
    look: "външност, характер, мъртъв герой, който действа, правило на света, място, събитие",
  },
  editor: {
    project: "Ръкопис",
    unit: "Глава",
    memory: "Паметта на ръкописа",
    kinds: { character: "Име и термин", place: "Правопис", rule: "Стил", event: "Решение" },
    expert: "редактор",
    look: "изписване на имена и термини, приет правопис, стил, вече взети редакторски решения",
  },
  lawyer: {
    project: "Дело",
    unit: "Документ",
    memory: "Паметта на делото",
    kinds: { character: "Страна", place: "Срок", rule: "Клауза", event: "Събитие" },
    expert: "юрист",
    look: "страни, суми, срокове, дати, клаузи и вече установени обстоятелства",
  },
  marketing: {
    project: "Кампания",
    unit: "Текст",
    memory: "Паметта на марката",
    kinds: { character: "Аудитория", place: "Канал", rule: "Правило на марката", event: "Оферта" },
    expert: "маркетолог",
    look: "име и тон на марката, цени и оферти, обещания, аудитория, забранени думи",
  },
  teacher: {
    project: "Курс",
    unit: "Урок",
    memory: "Паметта на курса",
    kinds: { character: "Ученик", place: "Тема", rule: "Правило", event: "Изучено" },
    expert: "учител",
    look: "определения, формули, правила, нивото на ученика и вече изучено",
  },
  translator: {
    project: "Превод",
    unit: "Текст",
    memory: "Речникът на превода",
    kinds: { character: "Термин", place: "Име", rule: "Правило", event: "Решение" },
    expert: "преводач",
    look: "приетите преводи на термини и имена, формата на обръщение, правилата за стил",
  },
  programmer: {
    project: "Проект",
    unit: "Файл",
    memory: "Паметта на проекта",
    kinds: { character: "Компонент", place: "Интерфейс", rule: "Правило", event: "Решение" },
    expert: "програмист",
    look: "имена на функции и полета, интерфейси, версии, правила за кода и взети решения",
  },
  business: {
    project: "Бизнес",
    unit: "Документ",
    memory: "Паметта на бизнеса",
    kinds: { character: "Клиент или партньор", place: "Пазар", rule: "Правило", event: "Решение" },
    expert: "бизнес съветник",
    look: "цени, числа, цели, партньори, срокове и вече взети решения",
  },
  architect: {
    project: "Обект",
    unit: "Описание",
    memory: "Паметта на обекта",
    kinds: { character: "Помещение", place: "Размер", rule: "Норма", event: "Решение" },
    expert: "архитект",
    look: "размери, площи, материали, норми, изисквания на клиента и взети решения",
  },
  doctor: {
    project: "Здравен дневник",
    unit: "Запис",
    memory: "Паметта на дневника",
    kinds: { character: "Лекарство", place: "Алергия", rule: "Указание на лекар", event: "Изследване" },
    expert: "здравен асистент (не лекар)",
    look: "лекарства и дози, алергии, указания на лекуващия лекар, стойности от изследвания",
  },
  accountant: {
    project: "Фирма",
    unit: "Документ",
    memory: "Паметта на фирмата",
    kinds: { character: "Контрагент", place: "Сметка", rule: "Правило", event: "Плащане" },
    expert: "счетоводител",
    look: "суми, ДДС, дати, контрагенти, номера на документи и приети правила",
  },
  coach: {
    project: "План",
    unit: "Тренировка",
    memory: "Паметта на плана",
    kinds: { character: "Цел", place: "Ограничение", rule: "Правило", event: "Резултат" },
    expert: "личен треньор",
    look: "цели, травми и ограничения, тежести, повторения, режим и постигнати резултати",
  },
  chef: {
    project: "Кухня",
    unit: "Рецепта",
    memory: "Паметта на кухнята",
    kinds: { character: "Продукт", place: "Алергия", rule: "Правило", event: "Меню" },
    expert: "готвач",
    look: "алергии и непоносимости, продукти, количества, порции и правила на дома",
  },
  listener: {
    project: "Моят свят",
    unit: "Мисъл",
    memory: "Паметта на разговорите",
    kinds: { character: "Човек", place: "Място", rule: "Важно за мен", event: "Случка" },
    expert: "внимателен събеседник",
    look: "хора, случки и неща, които човекът е казал, че са важни за него",
  },
});

export const DEFAULT_SPECIALIST = "writer";

export function specialistProfile(id) {
  const key = Object.hasOwn(SPECIALIST_PROFILES, id) ? id : DEFAULT_SPECIALIST;
  return { id: key, ...SPECIALIST_PROFILES[key] };
}

// What the page needs to name things: no prompts, only the words.
export function publicSpecialistProfiles() {
  return Object.fromEntries(
    Object.entries(SPECIALIST_PROFILES).map(([id, { project, unit, memory, kinds }]) => [id, { project, unit, memory, kinds }]),
  );
}
