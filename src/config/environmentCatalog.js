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
    general("OPENAI_CHAT_MODEL", "AI ядро", "Модел за основния разговор.", {
      hasDefault: true,
    }),
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
      "OPENAI_API_URL",
      "AI ядро",
      "Незадължителен адрес само за стария анализ на изображения.",
      { hasDefault: true, state: "compatibility" },
    ),

    secret(
      "OPENSEARCH_HOST",
      "Памет",
      "Адрес на постоянната OpenSearch памет.",
      { requiredNow: true },
    ),
    secret("OPENSEARCH_PORT", "Памет", "Порт на OpenSearch.", {
      requiredNow: true,
    }),
    secret("OPENSEARCH_USERNAME", "Памет", "Потребител за OpenSearch.", {
      requiredNow: true,
    }),
    secret("OPENSEARCH_PASSWORD", "Памет", "Парола за OpenSearch.", {
      requiredNow: true,
    }),
    general(
      "OPENSEARCH_TLS_REJECT_UNAUTHORIZED",
      "Памет",
      "Задължителна проверка на TLS сертификата.",
      { hasDefault: true },
    ),
    secret(
      "MEMORY_OWNER_ID",
      "Памет",
      "Стабилен собственик на основната лична памет.",
      { requiredNow: true },
    ),
    general(
      "MEMORY_INDEX",
      "Памет",
      "Име на индекса за лични и проектни факти.",
      { hasDefault: true },
    ),
    general("CONVERSATION_INDEX", "Памет", "Име на индекса за разговорите.", {
      hasDefault: true,
    }),
    general(
      "AUDIT_INDEX",
      "Памет",
      "Име на неизтриваемия дневник на действията.",
      { hasDefault: true },
    ),
    general(
      "CONFIRMATION_INDEX",
      "Памет",
      "Индекс за еднократни потвърждения.",
      { hasDefault: true },
    ),
    general(
      "TESTER_ACCESS_INDEX",
      "Памет",
      "Индекс за одобрени тестови профили.",
      { hasDefault: true },
    ),

    secret(
      "MCP_ACCESS_TOKEN",
      "ChatGPT / MCP",
      "Legacy защита на MCP; не се използва за нови OAuth артефакти след миграцията.",
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
      "MCP_OAUTH_REPLAY_INDEX",
      "ChatGPT / MCP",
      "Индекс за устойчивата еднократна OAuth защита.",
      { hasDefault: true },
    ),

    general(
      "SUPABASE_URL",
      "Тестови профили",
      "Адрес на Supabase Auth проекта.",
      { requiredNow: true },
    ),
    general(
      "SUPABASE_PUBLISHABLE_KEY",
      "Тестови профили",
      "Публичен ключ за Supabase Auth.",
      { requiredNow: true },
    ),
    secret(
      "SUPABASE_SESSION_ENCRYPTION_KEY",
      "Тестови профили",
      "Криптира Supabase сесиите в браузъра.",
      { requiredNow: true },
    ),
    secret(
      "SYNCHRON_TEST_INVITE_CODE",
      "Тестови профили",
      "Частен код за разрешена регистрация.",
      { requiredNow: true },
    ),
    general(
      "SYNCHRON_PRIMARY_SUPABASE_USER_ID",
      "Тестови профили",
      "Незадължително свързва един Supabase профил с основния собственик.",
    ),
    general(
      "SUPABASE_TIMEOUT_MS",
      "Тестови профили",
      "Максимално време за Supabase заявка.",
      { hasDefault: true },
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
      "Разрешеното хранилище на SYNCHRON-X.",
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

    secret(
      "DIGITALOCEAN_API_TOKEN",
      "DigitalOcean",
      "Самопроверка на App Platform и облачните ресурси.",
    ),
    secret(
      "DIGITALOCEAN_TOKEN",
      "DigitalOcean",
      "Старо име на DigitalOcean token; използва се само ако новото липсва.",
      { state: "compatibility" },
    ),
    general(
      "DIGITALOCEAN_APP_ID",
      "DigitalOcean",
      "Идентификатор на работещото App Platform приложение.",
    ),
    general("DIGITALOCEAN_API_URL", "DigitalOcean", "DigitalOcean API адрес.", {
      hasDefault: true,
    }),
    general(
      "DIGITALOCEAN_DASHBOARD_URL",
      "DigitalOcean",
      "Адрес към таблото в Работния център.",
      { hasDefault: true },
    ),

    secret(
      "CLOUDFLARE_API_TOKEN",
      "Cloudflare",
      "Проверка само за четене на зоната и DNS.",
    ),
    general(
      "CLOUDFLARE_ZONE_ID",
      "Cloudflare",
      "Идентификатор на Cloudflare зоната.",
    ),
    general("CLOUDFLARE_API_URL", "Cloudflare", "Cloudflare API адрес.", {
      hasDefault: true,
    }),
    general(
      "CLOUDFLARE_DASHBOARD_URL",
      "Cloudflare",
      "Адрес към таблото в Работния център.",
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
      "LOGIC_CORE_URL",
      "Стар модул",
      "Останала документация за отделния Python Logic Core; Node приложението не я използва.",
      { state: "unused" },
    ),
  ].map((item) => Object.freeze(item)),
);

export function getEnvironmentCatalog() {
  return ENVIRONMENT_CATALOG;
}
