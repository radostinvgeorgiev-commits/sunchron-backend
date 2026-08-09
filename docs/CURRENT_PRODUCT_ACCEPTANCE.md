# SYNCHRON-X — текущо продуктово приемане

Това е единственият актуален документ за състоянието на продукта и следващите
приемателни проверки. Историческите одити пазят контекст, но не са roadmap и не
доказват състоянието на текущия deployment. Exact commit и резултатът от
production проверките винаги се установяват по
[`OPERATIONS_RUNBOOK.md`](./OPERATIONS_RUNBOOK.md).

## Потвърдено в production

- Сайтът се публикува от `main` чрез DigitalOcean App Platform; Cloudflare
  обслужва DNS и edge proxy, без отделен Cloudflare Tunnel.
- Разговорният AI използва OpenAI Responses API по подразбиране. Gemini, Grok
  от xAI и Anthropic са добавени като опционални адаптери, но production
  използването им остава непотвърдено, докато не бъдат добавени secrets и не се
  изпълни реален provider smoke тест. DigitalOcean е hosting, а не резервен
  разговорен AI доставчик.
- `/health` и `/health/ready` проверяват текущата версия и readiness.
- OpenSearch cluster health е зелен, а production memory acceptance изпълнява
  9 от 9 изолирани стъпки, почиства тестовите данни и не променя личната памет.
- Чрез read-only owner проверка са потвърдени 3 реални OpenSearch restore точки.
  Това доказва наличен backup inventory, но не доказва успешно възстановяване.
- MCP транспортът, каталогът и OAuth readiness са проверени. MCP транспортът не
  е Cloudflare Tunnel и не е втори deployment канал.
- Supabase runtime конфигурацията и защитата на сесиите са налични. Тези флагове
  не доказват реална регистрация и последващ вход на нов потребител.
- Read-only owner проверка на 6 август 2026 г. показва Supabase организация на
  Free Plan, проект `SYNCHRON-X` със статус `Healthy`/`nano` и
  `Advisor found no issues`; табът **Security Advisor → Errors** е празен. Това е
  наблюдение към конкретната дата, а не постоянна гаранция за сигурност.
- Същата read-only проверка показва `Last backup: No backups`. Supabase Dashboard
  изрично казва, че Free Plan не включва project backups. Това е текущ блокер,
  а не включена защита.

## Текущ release candidate

- `GET /health/dependencies` прави ограничена жива read-only проверка на
  OpenSearch и Supabase. Успех има само когато и двете зависимости са достъпни;
  при проблем маршрутът връща `503` и безопасен error code, без secrets.
- `GET /health/backups` проверява read-only backup състоянието. Публичният
  отговор показва само статус: не показва resource IDs, брой точки или дати и
  изрично казва, че не доказва restore. Докато Supabase няма потвърден backup,
  общият статус е `partially-verified` и HTTP отговорът е `503`, а не зелено
  backup health.
- За OpenSearch маршрутът проверява restore точките само за точния production
  cluster и изисква последната точка да е до 48 часа. За Supabase
  runtime publishable key не може да докаже provider backup policy, затова
  статусът остава `unverified`. Отделната owner проверка вече доказва, че при
  текущия Free Plan project backup няма.
- `GET /health/storage-report` обединява двата безопасни отчета с транспортен
  HTTP `200`, така че edge 5xx страница да не скрива точния статус. Това не
  превръща частичния backup отчет в зелено health доказателство.
- Scheduled production smoke проверява dependency и backup отчетите чрез
  `/health/storage-report`. Тези промени стават production доказателство едва
  след merge, deployment на точния SHA и успешен `synchron/production-smoke`
  за същия SHA.

## Още не е прието

1. Реална регистрация, потвърдена с един нов изолиран тестов профил.
2. Logout и повторен login със същия профил, проверена защитена сесия и
   отделено потребителско пространство.
3. Owner acceptance за ChatGPT MCP, GitHub и Google по
   [`OWNER_ACCEPTANCE_RUNBOOK.md`](./OWNER_ACCEPTANCE_RUNBOOK.md).
4. OpenSearch restore/fork drill. Има 3 restore точки, но restore не е тестван.
5. Supabase backup и възстановяване. При текущия Free Plan project backup няма;
   dashboard посочва до 7 дни scheduled backups при платен Pro plan, но upgrade
   не е разрешен и не е включван.
6. Google Cloud migration. Cloud Run template-ът и конфигурационният каталог са
   planning-only; няма приет GCP deployment, Firestore data plane, Identity
   Platform user migration или Vertex AI production provider.

## Следващи стъпки

1. Merge и deploy на текущия release candidate само след зелени локални и CI
   тестове и изрично разрешение.
2. Потвърждение на точния production SHA и успешен production smoke, включително
   `/health/dependencies` и `/health/backups`.
3. Реален signup/logout/login acceptance с нов изолиран профил; при грешка първо
   се определя причината, без несвързана архитектурна промяна.
4. Read-only owner acceptance за ChatGPT MCP, GitHub и Google. Режимът
   `COPILOT_AUTOMATION_DISABLED` е валидна отрицателна контрола; реалният GitHub
   write е отделен extended acceptance.
5. Отделно решение за Supabase backup: платен Pro plan със scheduled backups
   или планиран криптиран логически dump с `supabase db dump` в одобрено външно
   хранилище. Вторият вариант изисква отделен DB secret, retention, защитено
   съхранение и restore тест; не е включен. Преди решение се показват актуалната
   цена и пълният план; upgrade или нов secret не се добавят автоматично.
6. Restore drill само след отделното одобрение по-долу.

Google Cloud migration има отделен ред в
[`GOOGLE_CLOUD_CONFIGURATION_CATALOG.md`](./GOOGLE_CLOUD_CONFIGURATION_CATALOG.md).
Той не променя DigitalOcean baseline, OpenSearch memory или Supabase identity.
Няма приети Cloud Run resources, secrets, DNS промени или прехвърлени лични
данни, докато exact-SHA runtime, cost/IAM, data/identity, provider и rollback
gates не бъдат доказани поотделно.

## Посока след текущото приемане

След като горните проверки са зелени, развитието следва
[`PRODUCT_DIRECTION.md`](./PRODUCT_DIRECTION.md): център за действие в контекста
на чата, видими права, управляема памет, постоянни проектни пространства и
цикъл „Предложи → одобри → изпълни → провери“. Външните GitHub/MCP проекти в
този документ са само кандидати за последователна изолирана оценка; те не са
регистрирани като готови production инструменти.

## Действия само с изрично разрешение

- merge в `main` и production deployment;
- добавяне, премахване или ротация на production secret;
- OpenSearch restore/fork, след показана цена, cost ceiling, изолиран target и
  план за изтриване на временния ресурс;
- активиране на GitHub/Copilot write и всяко реално външно write действие;
- изтриване на production данни или потребителски профил;
- включване на платена услуга или промяна на backup plan.

Наличен инструмент, configuration flag, backup inventory или започнат
deployment никога не се записва като „готово“, преди крайният резултат да е
проверен.
