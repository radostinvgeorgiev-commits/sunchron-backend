# Текущ production acceptance

## Прието

- Canonical site: `https://cloudaicore.com`.
- Cloud Run публикува exact commit от `main`.
- Firestore е единственият runtime backend за памет и operational state.
- Identity Platform е единственият auth backend.
- OpenAI Responses API, Gemini и Grok имат директни адаптери.
- Task Orchestrator може да планира multi-step задачи.
- Instrumentalните задачи имат owner-scoped durable run с checkpoint-и и
  pause/resume/cancel API.
- Сайтът има Council режим, който пита OpenAI, Gemini и Grok и показва отделна
  структурирана препоръка преди изпълнение.
- AI CORE Code Write подготвя ограничен multi-engine plan и след точно
  потвърждение създава отделен branch, commit и Pull Request.
- MCP има OAuth boundary и актуален каталог.
- GitHub, Google Workspace, web search, memory и задачи минават през Capability
  Engine и audit.

## Задължителни проверки

1. `/health` връща exact SHA от `main`.
2. `/health/ready` е `ready`.
3. `/health/storage-report` показва healthy Firestore и Identity Platform.
4. Firestore backup статусът остава `unverified`, докато няма отделен restore
   тест; не се представя като доказан.
5. `synchron/production-smoke` е зелен.
6. Реална owner сесия изпълнява един read и един потвърден write acceptance.
7. Нов потребител се допуска само чрез одобрен тестов профил; health проверките
   не доказват сами реална регистрация.

## Следващо

Реален browser acceptance на Council → избор → разрешено действие, последван
от аватарна кодова задача: трите двигателя дават предложения, coding ролята
създава PR, CI минава, промяната се слива и след exact-SHA deployment се прави
визуална проверка.

Продуктовата посока е в `PRODUCT_DIRECTION.md`; оперативните стъпки са в
`OPERATIONS_RUNBOOK.md`.
