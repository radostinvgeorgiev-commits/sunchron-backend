# SYNCHRON-X

SYNCHRON-X е лична AI операционна система, която познава човека, има
постоянна контролирана памет и използва разрешени инструменти за изпълнение
на реални задачи. За всяка задача тя може да избира най-подходящия AI модел,
вместо да зависи от един-единствен AI.

AI аватарът е интерфейсът на системата — лицето, гласът, характерът и начинът
на общуване. Той не е цялата система.

SYNCHRON-X обединява:

- стабилен AI разговор;
- контролиран личен и проектен контекст;
- постоянна памет в OpenSearch;
- AI аватар като слой за общуване;
- разрешени инструменти за реални задачи;
- потвърждение преди рискови действия.

## Основен поток

`Сайт → SYNCHRON-X server → OpenAI Responses API → отговор`

Паметта и разрешените инструменти се добавят към този поток през сървърните
адаптери. DigitalOcean App Platform хоства приложението, но не е разговорен AI
доставчик.

Инструментите се избират през `Capability Engine` и `Tool Registry`. Регистрация
без изпълним адаптер и конфигурация не се счита за работеща интеграция.

## Конфигурация

Имената на нужните променливи са в `.env.example`. Реалните ключове се пазят
само като криптирани променливи в DigitalOcean и не се записват в GitHub.

Критичните runtime променливи се валидират централно при старт. При липсващи или
невалидни стойности приложението спира fail-closed без да отпечатва secret
стойности. Основните групи са:

- AI: `OPENAI_API_KEY`, `OPENAI_API_URL`, `OPENAI_TIMEOUT_MS`
- Bridge/MCP: `MCP_ACCESS_TOKEN`, `MCP_RESOURCE_URL`, `AGENT_KEY`
- Memory/OpenSearch: `OPENSEARCH_HOST`, `OPENSEARCH_PORT`,
  `OPENSEARCH_PROTOCOL`, `OPENSEARCH_USERNAME`, `OPENSEARCH_PASSWORD`
- Auth/identity: `GITHUB_*`, `GOOGLE_*`, `SUPABASE_URL`,
  `SUPABASE_PUBLISHABLE_KEY`
- Runtime: `PORT`, `HOST`, `DATABASE_URL`, `DEBUG_LOGS`

Безопасният статус на връзките е достъпен на:

`GET /health/integrations`

Той показва само дали конфигурацията е налична, без стойности на ключове.

Допълнителни runtime проверки:

- `GET /healthz` — процесът е жив;
- `GET /health/ready` и `GET /readyz` — readiness за AI, OpenSearch, memory
  acceptance и MCP bridge;
- `GET /health/bridge` — фази на bridge връзката, retry/cooldown и auth
  readiness без secret данни.

## Проверка

```bash
npm ci
npm test
npm audit --omit=dev --audit-level=high
```

Всеки push и pull request към `main` стартира автоматичните проверки.

## Локално стартиране

```bash
cp .env.example .env
npm ci
npm start
```

Сървърът слуша на `PORT` и `HOST`, като по подразбиране bind-ва на `0.0.0.0`
за container/tunnel deployment.

## Troubleshooting за tunnel/bridge връзката

- ако `/health/bridge` показва `connection.retry` или `cooldown`, провери
  `MCP_ACCESS_TOKEN`, `AGENT_KEY` и външната достъпност на `/mcp`;
- ако readiness е `not-ready`, първо виж `checks.bridge.lifecycle` и
  `checks.memory.status`;
- OpenSearch URL се нормализира от `OPENSEARCH_PROTOCOL/HOST/PORT`; не задавай
  protocol вътре в host стойността;
- `DEBUG_LOGS=true` включва структурирани connection събития, но secret полетата
  остават редакирани.

За проверка на точния production commit, readiness, MCP, memory acceptance и
безопасен incident/rollback ред използвай
[`docs/OPERATIONS_RUNBOOK.md`](docs/OPERATIONS_RUNBOOK.md). Не приемай стара
тестова бройка или commit от исторически audit за текущо състояние.
