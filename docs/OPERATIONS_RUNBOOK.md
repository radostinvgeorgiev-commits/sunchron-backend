# NovariumAI operations runbook

## Production proof

```bash
curl --fail --silent --show-error https://cloudaicore.com/health
curl --fail --silent --show-error https://cloudaicore.com/health/ready
curl --fail --silent --show-error https://cloudaicore.com/health/dependencies
curl --silent --show-error https://cloudaicore.com/health/backups
curl --fail --silent --show-error https://cloudaicore.com/health/storage-report
curl --fail --silent --show-error https://cloudaicore.com/api/auth/session
```

Сравни `health.commit` с exact SHA на `main` и изчакай пет последователни
съвпадения. Провери `synchron/production-smoke`, Cloud Run revision, Firestore
и Identity Platform. Health status не доказва, че нов потребител реално може
да се регистрира — това се тества с изолиран профил.

### Един merge наведнъж

Всеки merge в `main` пуска отделен Cloud Build (`synchron-main-deploy`).
Когато няколко merge-а влязат един след друг, builds се застъпват и
последният може да се провали (на 25.11.2026 build-ът за `86e6d31` завърши с
FAILURE, докато предишният още се публикуваше). Прави merge, изчакай
`Production smoke check` за точния SHA и чак тогава следващия. Ако build се
провали така, нов commit в `main` (например следващ PR) публикува всичко
натрупано.

## MCP

Изпрати JSON-RPC `tools/list` към `https://cloudaicore.com/mcp`. Каталогът
трябва да съдържа `get_google_cloud_runtime_status`, task capabilities и GitHub
write инструментите. За private tool очаквай 401 OAuth challenge със scope.

За една bounded проверка от аватара използвай
`get_google_cloud_project_diagnostics`. Тя проверява health/readiness, MCP,
Cloud Run, Cloud Build, връзката с Firestore и статуса на текущия Google Cloud
проект. За последните 30 минути отчита наличие на Cloud Run метрики и дали е
намерен запис със сериозност ERROR или по-висока. За Secret Manager показва
сумарен статус на версиите, към които сочи Cloud Run. Отчетът връща агрегирани
данни за метрики, логове и версии.

За пълна проверка активирай Cloud Monitoring, Cloud Logging, Cloud Resource
Manager и Secret Manager API в проекта. Работният акаунт на Cloud Run се
нуждае от `monitoring.timeSeries.list`, `logging.logEntries.list`,
`resourcemanager.projects.get` и `secretmanager.versions.get` за съответните
ресурси. За метриките и журналите могат да се използват `roles/monitoring.viewer`
и `roles/logging.viewer`. За версиите използвай роля за метаданни, например
`roles/secretmanager.viewer` върху тайните, към които сочи услугата.
`PARTIAL` показва кои проверки са върнали грешка или са недостъпни.

За owner-confirmed deploy се използва
`prepare_google_cloud_action` с `operation=run_cloud_build_trigger`,
`triggerName=synchron-main-deploy`, `location=global`, `branch=main` и точен
40-символен `commitSha`; `confirm_google_cloud_action` първо препроверява
trigger-а и после стартира само този SHA.

Разговорният аватар използва същия проверен capability engine. Read-only
заявките могат да върнат реален резултат в разговора; write заявките спират на
точна confirmation стъпка и не променят външна система преди owner потвърждение.

Claude и Codex не се приемат за работещи само защото са видими в UI. За всеки
двигател се проверяват конфигурацията, capability gate-ът, audit следата и
краен acceptance тест. Production write действия остават blocked без owner
confirmation.

## Кодова задача

1. Влез като owner и свържи GitHub OAuth.
2. Задай точна, ограничена задача.
3. Провери предложенията на OpenAI, Gemini и Grok и списъка с файлове.
4. Потвърди само точния confirmation id.
5. Провери PR diff и CI.
6. След merge изчакай exact-SHA Cloud Run deployment и тествай в браузър.

## Rollback

За лош application commit създай отделен PR с `git revert <sha>`, пусни всички
тестове и повтори production proof. Не използвай force push и не изтривай
данни. Не стартирай restore/fork без показани цел, цена, cleanup и изрично
разрешение.

Owner acceptance е описан в `OWNER_ACCEPTANCE_RUNBOOK.md`.

## Проследяване на първата кампания в ChatGPT Ads

Рекламите водят към `https://cloudaicore.com/plans` с
`utm_source=chatgpt&utm_medium=paid&utm_campaign=novarium-launch` и
`utm_content=variant-1`, `variant-2` или `variant-3`.

В Logs Explorer филтрирай по следните условия:

```text
resource.type="cloud_run_revision"
resource.labels.service_name="synchron-backend-google"
jsonPayload.utm_campaign="novarium-launch"
jsonPayload.utm_content!="smoke-test"
```

Сравнявай броя на събитията по `jsonPayload.event` и `jsonPayload.utm_content`.
`campaign_landing` брои зареждания, включително повторни. `campaign_early_access`
брои нови заявки за покана. `campaign_registration` брои създадени профили,
когато регистрацията е запазила адреса с параметрите на кампанията.
Тестовият вариант `smoke-test` може да се провери отделно.

## Език на публичния интерфейс

Параметърът `lang` избира езика на страницата, например `/plans?lang=tr`.
При липса на параметъра сайтът използва запомнения избор, после езика на
браузъра и накрая английски. Параметрите на кампанията се запазват при
преминаване към регистрация.

Българският текст е в HTML и в интерфейсните скриптове. Английските
съответствия са в `public/locale-en.js`. Допълнителните JSON речници
в `public/locales/` използват английския израз като ключ, така че промяната
на един израз да не размества останалите преводи. Допълнителните каталози
са подготвени предварително с M2M100. Липсващи преводи използват английския
текст. Разговори, профили и лична памет не се изпращат към преводача.
