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

## Плащания: Google Pay, Apple Pay и карта (Stripe)

Човекът плаща на страницата на Stripe (`checkout.stripe.com`). Stripe сам
показва Google Pay (Chrome, Android), Apple Pay (Safari, iPhone, Mac) и карта
според устройството. Номерът на картата никога не минава през сайта.
Единиците се добавят само от подписаното потвърждение на Stripe към
`/api/product/webhook`, веднъж за всяко плащане. След връщане страницата
`/plans` сама пита `/api/product/payment-status` и казва „Готово“, щом
единиците са добавени. Човекът се връща на същия адрес, от който е тръгнал
(novariumai.com или cloudaicore.com), за да остане влязъл.

Режими (`paymentMode`):

- `off`: никой не плаща. Така е по подразбиране.
- `test`: ключ `sk_test_…`, `PRODUCT_PAYMENTS_ENABLED=true`, тестова тайна за
  потвържденията и `PRODUCT_PAYMENTS_TEST_ACCOUNTS` с номерата на позволените
  профили (полето `account` от `/api/product/usage`). Само те виждат плащане и
  то е с тестови пари. Записите в базата са с `livemode: false`.
- `live`: ключ `sk_live_…`, live тайна и трите превключвателя
  `PRODUCT_PAYMENTS_ENABLED`, `PRODUCT_MERCHANT_READY`,
  `PRODUCT_UNIT_ECONOMICS_APPROVED`. Тестови събития се отказват.

Проба с тестови пари (преди истинските плащания):

1. Stripe (Sandbox) → Settings → Payment methods: включени Cards, Apple Pay и
   Google Pay. По избор отделна настройка само с тях; нейният `pmc_…` отива в
   `PRODUCT_STRIPE_PAYMENT_METHOD_CONFIG`.
2. Stripe (Sandbox) → Webhooks: адрес
   `https://novariumai.com/api/product/webhook` със събития
   `checkout.session.completed`, `checkout.session.async_payment_succeeded` и
   `checkout.session.async_payment_failed`. Тайната му я въвежда собственикът в
   Secret Manager.
3. Cloud Run, след „да“ от собственика: тестовият ключ и тайната от Secret
   Manager, `PRODUCT_PAYMENTS_ENABLED=true` и
   `PRODUCT_PAYMENTS_TEST_ACCOUNTS` с номера на тестовия профил.
4. Проверка: тестовият профил вижда „Тестов режим“ и „Избери пакет“, а всеки
   друг профил вижда „Плащанията предстоят“. Страницата на Stripe показва
   Google Pay в Chrome с карта в Google Pay и Apple Pay в Safari на iPhone.
   След тестово плащане `/plans` сама казва „Готово: 300 AI единици…“, а
   логовете в Cloud Run са без грешки. Тестова карта от документацията на
   Stripe въвежда само собственикът или скриптът на робота, никога истинска
   карта.

Истински плащания (по-късно): собственикът одобрява фирмата СИНХРОН Х ЕООД в
Stripe (данни, документ, сметка), въвежда live ключа и live тайната в Secret
Manager, после трите превключвателя стават `true` след неговото „да“. В
Stripe: Branding (логото и неоновите цветове на NovariumAI), публично име
„NovariumAI“, текст в извлечението „NOVARIUMAI“ и Customer emails → разписки
за успешни плащания. Преди това: условията за продажба и правото на отказ от
14 дни се проверяват с юрист (вж. `/plans`, „Преди плащане“).
