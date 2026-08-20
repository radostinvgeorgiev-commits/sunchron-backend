export const PRODUCT_NAME = "AI CORE";
// Keep the export for callers that still import the legacy symbol, but expose
// the public product name consistently as AI CORE.
export const TECHNICAL_PROJECT_NAME = PRODUCT_NAME;
export const PROJECT_NAME = PRODUCT_NAME;

export const PROJECT_DEFINITION =
  "AI CORE е лична AI операционна система, която познава човека, има постоянна контролирана памет и използва разрешени инструменти за изпълнение на реални задачи. За всяка задача тя може да избира най-подходящия AI модел, вместо да зависи от един-единствен AI.";

export const AVATAR_DEFINITION =
  "AI аватарът е интерфейсът на AI CORE — лицето, гласът, характерът и начинът на общуване.";

export const INTEGRATION_POLICY =
  "За всяка външна услуга първо се проверяват Tool Registry, изпълнимият адаптер, конфигурацията и реална заявка. Липсваща интеграция се добавя чрез Capability Engine с разрешения, потвърждение и одит. Не се създава отделен тунел, worker или втори deployment без доказана техническа необходимост.";

export const PROJECT_BASE_CONTEXT = Object.freeze([
  `Проектът се казва ${PROJECT_NAME}.`,
  PROJECT_DEFINITION,
  AVATAR_DEFINITION,
  "Първата цел е работеща система за един човек: сайт, стабилен AI разговор, постоянна памет, личен AI аватар, реални интеграции и след това тестове с малък брой хора.",
  "Текущият фокус е стабилен разговор, реално проверена постоянна памет и изпълнение на разрешени задачи от чата.",
  "Каноничният сайт е https://cloudaicore.com. Основното хранилище е radostinvgeorgiev-commits/sunchron-backend, а активната инфраструктура е само в Google Cloud.",
  "OpenAI Responses API е разговорният доставчик по подразбиране. Gemini и Grok от xAI са опционални директни адаптери, които се включват само чрез изрична конфигурация.",
  "Firestore е постоянната AI памет и хранилището за потребители, настройки, разрешения, задачи и журнал в Google Cloud.",
  "GitHub, Google и другите услуги са инструменти. Наличието им в регистъра не доказва, че са свързани и работят; това се твърди само след реален тест.",
  INTEGRATION_POLICY,
  "Данните принадлежат на човека. Радко контролира паметта, разрешенията и рисковите действия.",
  "Не се изграждат токен, фондация, корпорация или масова платформа преди работещ продукт, доказана полза и реални потребители.",
]);

export const CANONICAL_PROJECT_MEMORY_ID = "canonical-project-definition";

export function isSupersededProjectDefinition(fact) {
  if (typeof fact !== "string") return false;
  const text = fact.toLocaleLowerCase("bg-BG");
  return (
    /първата\s+практическа\s+цел.*личен\s+ai\s+аватар/u.test(text) ||
    /текущата\s+цел.*работещ\s+личен\s+ai\s+аватар/u.test(text) ||
    /synchron-x\s+е\s+технологичното\s+ядро.*личен\s+ai\s+аватар/u.test(text)
  );
}
