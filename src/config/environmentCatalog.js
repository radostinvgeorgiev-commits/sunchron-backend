const secret = (key, area, purpose, options = {}) => ({
  key,
  area,
  purpose,
  sensitivity: "secret",
  state: "active",
  ...options,
});

const general = (key, area, purpose, options = {}) => ({
  key,
  area,
  purpose,
  sensitivity: "general",
  state: "active",
  ...options,
});

export const ENVIRONMENT_CATALOG = Object.freeze(
  [
    secret(
      "OPENAI_API_KEY",
      "AI ядро",
      "Разговор, планиране, търсене и анализ.",
      { requiredNow: true },
    ),
    general(
      "AI_CORE_PROVIDER",
      "AI ядро",
      "Разговорен доставчик: openai, gemini или grok. По подразбиране е openai.",
      { hasDefault: true },
    ),
    general("OPENAI_CHAT_MODEL", "AI ядро", "Модел за основния разговор.", {
      hasDefault: true,
    }),
    general(
      "AI_CORE_COUNCIL_MODEL",
      "AI ядро",
      "Моделът, който сравнява отговорите на OpenAI, Gemini и Grok.",
      { hasDefault: true },
    ),
    general(
      "OPENAI_PLANNER_MODEL",
      "AI ядро",
      "Модел за планиране на инструментите.",
      { hasDefault: true },
    ),
    general(
      "OPENAI_DOCUMENT_MODEL",
      "AI ядро",
      "Модел за анализ на документи от Drive.",
      { hasDefault: true },
    ),
    general("OPENAI_VISION_MODEL", "AI ядро", "Модел за анализ на снимки.", {
      hasDefault: true,
    }),
    general(
      "WEB_SEARCH_MODEL",
      "AI ядро",
      "Модел за актуално интернет търсене.",
      { hasDefault: true },
    ),
    general(
      "OPENAI_TIMEOUT_MS",
      "AI ядро",
      "Максимално време за основен AI отговор.",
      { hasDefault: true },
    ),
    general(
      "OPENAI_PLANNER_TIMEOUT_MS",
      "AI ядро",
      "Максимално време за плана на агента.",
      { hasDefault: true },
    ),
    general(
      "OPENAI_RESPONSES_URL",
      "AI ядро",
      "Незадължителен адрес за Responses API заявките.",
      { hasDefault: true },
    ),
    general(
      "OPENAI_API_URL",
      "AI ядро",
      "Незадължителен адрес само за стария анализ на изображения.",
      { hasDefault: true, state: "compatibility" },
    ),
    secret(
      "GEMINI_API_KEY",
      "AI ядро",
      "Незадължителен ключ за Gemini разговори.",
    ),
    general("GEMINI_MODEL", "AI ядро", "Модел за Gemini разговори.", {
      hasDefault: true,
    }),
    general(
      "GEMINI_API_URL",
      "AI ядро",
      "Незадължителен базов адрес за Gemini API.",
      { hasDefault: true },
    ),
    general(
      "GEMINI_TIMEOUT_MS",
      "AI ядро",
      "Максимално време за Gemini разговор.",
      { hasDefault: true },
    ),
    secret(
      "GROK_API_KEY",
      "AI ядро",
      "Незадължителен ключ за Grok разговори от xAI.",
    ),
    general("GROK_MODEL", "AI ядро", "Модел за Grok разговори от xAI.", {
      hasDefault: true,
    }),
    general(
      "GROK_API_URL",
      "AI ядро",
      "Незадължителен адрес за xAI Chat Completions API.",
      { hasDefault: true },
    ),
    general(
      "GROK_TIMEOUT_MS",
      "AI ядро",
      "Максимално време за Grok разговор.",
      { hasDefault: true },
    ),

    general(
      "MEMORY_BACKEND",
      "Памет",
      "Активен backend за паметта: firestore.",
      { hasDefault: true },
    ),
    general(
      "PERSISTENCE_BACKEND",
      "Памет",
      "Backend за потвърждения и audit: firestore.",
      { hasDefault: true },
    ),
    general(
      "GOOGLE_CLOUD_PROJECT",
      "Google Cloud",
      "Project ID за Cloud Run service identity и Firestore.",
    ),
    general(
      "FIRESTORE_DATABASE_ID",
      "Памет",
      "Firestore database ID; по подразбиране е (default).",
      { hasDefault: true },
    ),
    general(
      "FIRESTORE_PROFILE_COLLECTION",
      "Памет",
      "Колекция за личната и проектната памет.",
      { hasDefault: true },
    ),
    general(
      "FIRESTORE_CONVERSATION_COLLECTION",
      "Памет",
      "Колекция за историята на разговорите.",
      { hasDefault: true },
    ),
    general(
      "FIRESTORE_CONFIRMATION_COLLECTION",
      "Памет",
      "Колекция за еднократните потвърждения.",
      { hasDefault: true },
    ),
    general(
      "FIRESTORE_AUDIT_COLLECTION",
      "Памет",
      "Колекция за неизтриваемия журнал на действията.",
      { hasDefault: true },
    ),
    general(
      "FIRESTORE_TESTER_ACCESS_COLLECTION",
      "Памет",
      "Firestore колекция за одобрените тестови профили.",
      { hasDefault: true },
    ),
    general(
      "FIRESTORE_WORKSPACE_COLLECTION",
      "Работна област",
      "Firestore колекция за owner-isolated workspace state.",
      { hasDefault: true },
    ),
    general(
      "FIRESTORE_TASK_COLLECTION",
      "Задачи",
      "Firestore колекция за owner-isolated задачи.",
      { hasDefault: true },
    ),
    general(
      "FIRESTORE_TASK_RUN_COLLECTION",
      "Устойчиви изпълнения",
      "Firestore колекция за checkpoint-и и възстановяване на AI задачи.",
      { hasDefault: true },
    ),
    general(
      "FIRESTORE_GITHUB_SESSION_COLLECTION",
      "GitHub",
      "Firestore колекция за криптираните GitHub OAuth сесии.",
      { hasDefault: true },
    ),
    general(
      "FIRESTORE_GOOGLE_SESSION_COLLECTION",
      "Google",
      "Firestore колекция за криптираните Google OAuth сесии.",
      { hasDefault: true },
    ),
    general(
      "FIRESTORE_MCP_GRANT_COLLECTION",
      "ChatGPT / MCP",
      "Firestore колекция за durable MCP grants.",
      { hasDefault: true },
    ),
    general(
      "FIRESTORE_MCP_REPLAY_COLLECTION",
      "ChatGPT / MCP",
      "Firestore колекция за атомичната MCP replay защита.",
      { hasDefault: true },
    ),
    general(
      "FIRESTORE_REQUEST_TIMEOUT_MS",
      "Памет",
      "Максимално време за Firestore REST заявка.",
      { hasDefault: true },
    ),

    secret(
      "MEMORY_OWNER_ID",
      "Памет",
      "Стабилен собственик на основната лична памет.",
      { hasDefault: true },
    ),
    secret(
      "MCP_ACCESS_TOKEN",
      "ChatGPT / MCP",
      "Дълъг защитен fallback ключ за MCP OAuth bootstrap.",
      { requiredNow: true },
    ),
    secret(
      "MCP_OAUTH_SECRET",
      "ChatGPT / MCP",
      "Отделен криптографски ключ за нови OAuth code/access/refresh артефакти.",
    ),
    general(
      "MCP_RESOURCE_URL",
      "ChatGPT / MCP",
      "Каноничен HTTPS адрес на MCP ресурса.",
      { hasDefault: true },
    ),
    general(
      "MCP_OPENAI_TUNNEL_RESOURCE_URL",
      "ChatGPT / MCP",
      "Точният ресурс на одобрения OpenAI Secure MCP Tunnel.",
    ),
    general(
      "AUTH_BACKEND",
      "Тестови профили",
      "Активен auth adapter: identity-platform.",
      { hasDefault: true },
    ),
    general(
      "IDENTITY_PLATFORM_PROJECT_ID",
      "Тестови профили",
      "Google Cloud project ID за Identity Platform.",
      { hasProtectedFallback: true },
    ),
    secret(
      "IDENTITY_PLATFORM_API_KEY",
      "Тестови профили",
      "Ограничен API ключ за Identity Platform REST заявките.",
    ),
    general(
      "IDENTITY_PLATFORM_TIMEOUT_MS",
      "Тестови профили",
      "Максимално време за Identity Platform заявка.",
      { hasDefault: true },
    ),
    general(
      "IDENTITY_PLATFORM_REQUIRE_EMAIL_VERIFICATION",
      "Тестови профили",
      "Изисква потвърден имейл преди Identity Platform вход.",
      { hasDefault: true },
    ),
    secret(
      "USER_SESSION_ENCRYPTION_KEY",
      "Тестови профили",
      "Криптира потребителските сесии независимо от auth доставчика.",
      { hasProtectedFallback: true },
    ),
    general(
      "SYNCHRON_PRIMARY_USER_ID",
      "Тестови профили",
      "Свързва един потребител от активния auth доставчик с основния собственик.",
    ),
    secret(
      "SYNCHRON_TEST_INVITE_CODE",
      "Тестови профили",
      "Незадължителен оперативен код за tester-auth администрацията.",
    ),
    secret(
      "GITHUB_CLIENT_ID",
      "GitHub",
      "OAuth идентификатор за вход и кодови задачи.",
      { requiredNow: true },
    ),
    secret("GITHUB_CLIENT_SECRET", "GitHub", "OAuth тайна за GitHub.", {
      requiredNow: true,
    }),
    general(
      "GITHUB_REDIRECT_URI",
      "GitHub",
      "Защитен обратен адрес след GitHub вход.",
      { hasDefault: true },
    ),
    secret(
      "GITHUB_SESSION_ENCRYPTION_KEY",
      "GitHub",
      "Отделен ключ за GitHub сесиите.",
      { hasDefault: true },
    ),
    general(
      "GITHUB_REPOSITORY",
      "GitHub",
      "Разрешеното хранилище на AI CORE.",
      { hasDefault: true },
    ),
    general(
      "SYNCHRON_OWNER_GITHUB_LOGIN",
      "GitHub",
      "Единственият GitHub собственик с администраторски права.",
      { hasDefault: true },
    ),
    general(
      "GITHUB_SESSION_INDEX",
      "GitHub",
      "OpenSearch индекс за защитени GitHub сесии.",
      { hasDefault: true },
    ),
    general("GITHUB_API_URL", "GitHub", "Незадължителен GitHub API адрес.", {
      hasDefault: true,
    }),
    secret(
      "GITHUB_TOKEN",
      "GitHub",
      "Стар резервен token за директни GitHub заявки; сегашният поток използва OAuth.",
      { state: "compatibility" },
    ),

    secret(
      "GOOGLE_CLIENT_ID",
      "Google",
      "OAuth идентификатор за Drive, Calendar и Gmail.",
    ),
    secret("GOOGLE_CLIENT_SECRET", "Google", "OAuth тайна за Google."),
    general(
      "GOOGLE_REDIRECT_URI",
      "Google",
      "Защитен обратен адрес след Google вход.",
    ),
    secret(
      "GOOGLE_SESSION_ENCRYPTION_KEY",
      "Google",
      "Криптира Google сесиите.",
    ),
    general(
      "GOOGLE_SESSION_INDEX",
      "Google",
      "OpenSearch индекс за защитени Google сесии.",
      { hasDefault: true },
    ),
    general(
      "GOOGLE_CONNECT_URL",
      "Google",
      "Незадължителен външен адрес за Google свързване.",
      { hasDefault: true },
    ),

    general(
      "GOOGLE_CLOUD_CONSOLE_URL",
      "Google Cloud",
      "Адрес към Google Cloud Console в Работния център.",
      { hasDefault: true },
    ),

    general(
      "CHATGPT_WORK_URL",
      "Интерфейс",
      "Адрес към ChatGPT в Работния център.",
      { hasDefault: true },
    ),
    general("OAUTH_RATE_LIMIT", "Сигурност", "OAuth заявки за 15 минути.", {
      hasDefault: true,
    }),
    general(
      "PRIVATE_API_RATE_LIMIT",
      "Сигурност",
      "Частни API заявки за 15 минути.",
      { hasDefault: true },
    ),
    general(
      "PAID_AI_RATE_LIMIT",
      "Сигурност",
      "Платени AI заявки за 15 минути.",
      { hasDefault: true },
    ),
    general("APP_COMMIT_SHA", "Runtime", "Точният публикуван Git commit.", {
      managed: true,
    }),
    general("NODE_ENV", "Runtime", "Production или test режим.", {
      requiredNow: true,
    }),
    general("PORT", "Runtime", "Вътрешен HTTP порт.", { hasDefault: true }),
    general(
      "STORAGE_HEALTH_TIMEOUT_MS",
      "Наблюдение",
      "Максимално време за Firestore и Identity Platform здравна проверка.",
      { hasDefault: true },
    ),
    general(
      "BACKUP_HEALTH_TIMEOUT_MS",
      "Наблюдение",
      "Максимално време за read-only проверка на restore точките.",
      { hasDefault: true },
    ),
  ].map((item) => Object.freeze(item)),
);

export function getEnvironmentCatalog() {
  return ENVIRONMENT_CATALOG;
}
