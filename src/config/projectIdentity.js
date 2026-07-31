export const PRODUCT_NAME = "AI CORE";
export const TECHNICAL_PROJECT_NAME = "NOVARIUM / SYNCHRON-X";
export const PROJECT_NAME = `${PRODUCT_NAME} (${TECHNICAL_PROJECT_NAME})`;

export const PROJECT_DEFINITION =
  "AI CORE е лична AI операционна система, която познава човека, има постоянна контролирана памет и използва разрешени инструменти за изпълнение на реални задачи. За всяка задача тя може да избира най-подходящия AI модел, вместо да зависи от един-единствен AI. SYNCHRON-X остава техническото име на текущото ядро и домейна.";

export const AVATAR_DEFINITION =
  "AI аватарът е интерфейсът на AI CORE — лицето, гласът, характерът и начинът на общуване.";

export const BRIDGE_FIRST_POLICY =
  "За всяка външна услуга първо се търси и проверява реален мост. Ако има работещ мост, използва се той; ако няма, това се казва честно и се предлага конкретен мост за изграждане. Мостът не заобикаля разрешенията, потвържденията или одита.";

export const PROJECT_BASE_CONTEXT = Object.freeze([
  `Проектът се казва ${PROJECT_NAME}.`,
  PROJECT_DEFINITION,
  AVATAR_DEFINITION,
  "Първата цел е работеща система за един човек: сайт, стабилен AI разговор, постоянна памет, личен AI аватар, реални интеграции и след това тестове с малък брой хора.",
  "Текущият фокус е стабилен разговор, реално проверена постоянна памет и изпълнение на разрешени задачи от чата.",
  "Основното хранилище е radostinvgeorgiev-commits/sunchron-backend, а DigitalOcean App Platform публикува клона main.",
  "OpenAI Responses API е единственият разговорен AI. Старият DigitalOcean Agent е премахнат и не се използва като резервен.",
  "OpenSearch е постоянната AI памет. Supabase е предвиден за потребители, настройки, разрешения, задачи и журнал, а не за замяна на AI паметта.",
  "GitHub, Google и другите услуги са инструменти. Наличието им в регистъра не доказва, че са свързани и работят; това се твърди само след реален тест.",
  BRIDGE_FIRST_POLICY,
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
