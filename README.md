# SYNCHRON-X AI CORE

Лична AI операционна система, достъпна на
[cloudaicore.com](https://cloudaicore.com). AI CORE разговаря, пази изолирана
памет и изпълнява само разрешени инструменти.

## Архитектура

- Node.js 22 + Express;
- Google Cloud Run production runtime;
- Firestore за памет, задачи, workspace, OAuth сесии, потвърждения и audit;
- Google Identity Platform за вход и тестови профили;
- Claude чрез Anthropic API като основен разговорен и coding двигател;
- OpenAI, Gemini и Grok като незадължителни съветници при конфигурирани ключове;
- Codex е изключен като изпълнител; запазват се старите профили и настройки;
- GitHub OAuth за read и защитени branch/commit/PR операции;
- Google OAuth за Drive, Gmail и Calendar;
- OAuth-защитен MCP адрес: `https://cloudaicore.com/mcp`.

Task Orchestrator разделя заявката на стъпки, избира capability и изпълнява
реалния адаптер. При кодова задача наличните съветници предлагат решения.
Claude подготвя ограничен набор от цели файлове, а записът
започва само след точно еднократно потвърждение. `main` никога не се променя
директно от задачата.

Когато Claude не е достъпен, няма автоматично превключване към друг двигател.
Настройките `AI_CORE_PROVIDER`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` и
`ANTHROPIC_TIMEOUT_MS` се управляват от собственика; свързването на Claude.ai
към MCP OAuth е отделно от Anthropic API за основния двигател.

В production default backend-ите са Firestore и Identity Platform; legacy
OpenSearch/Supabase се използват само при изрична конфигурация.

## Локално стартиране

```bash
npm ci
cp .env.example .env
npm start
```

Попълни тайните само в локалния `.env` или Google Secret Manager. Не ги
commit-вай и не ги изпращай в чат.

## Проверка

```bash
npm test
```

Production acceptance изисква exact-SHA `/health`, зелено `/health/ready`,
Firestore + Identity Platform проверки, актуален MCP каталог и успешен
`synchron/production-smoke`.

Виж:

- `docs/OPERATIONS_RUNBOOK.md`
- `docs/STAGING_AND_RELEASE_GATES.md`
- `docs/CURRENT_PRODUCT_ACCEPTANCE.md`
- `docs/DEPLOYMENT_READINESS_CHECKLIST.md`
- `docs/OWNER_ACCEPTANCE_RUNBOOK.md`
- `docs/PRODUCT_DIRECTION.md`
- `docs/GOOGLE_CLOUD_CONFIGURATION_CATALOG.md`
