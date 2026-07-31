# Пълен технически одит на NOVARIUM / SYNCHRON-X

Дата: 31 юли 2026 г.

Проверен commit: `d5300c52fa91cf5c70e2dd744c4f2d77d617861e`

Production доказателство: GitHub Actions run `30650175520`

Обхват: актуалният `main`, наличната DigitalOcean App Platform конфигурация,
GitHub Actions, приложният код и автоматичните тестове.

## Кратко обобщение

### Какво е добро

- Production работи на точния проверен commit. Независимият smoke workflow
  доказва стабилен commit, публичен сайт, liveness, readiness, реален изолиран
  OpenSearch запис/прочит/промяна/изтриване, непроменена лична памет, MCP
  каталог и OAuth challenge, както и готовност на тестовите профили.
- Локалният пакет има 382 теста: 382 успешни, 0 неуспешни и 0 пропуснати.
  Production startup acceptance изпълнява реалния изолиран OpenSearch поток. Production зависимостите имат 0 известни high
  уязвимости.
- Собственикът и тестовите потребители получават отделни `memoryOwnerId`.
  Всички основни заявки към паметта филтрират по собственик.
- MCP OAuth има PKCE, CSRF защита, кратки access tokens, въртящи refresh tokens,
  scopes и устойчив еднократен replay guard в OpenSearch.
- Рисковите GitHub, Calendar и постоянни memory write действия използват
  устойчиви еднократни потвърждения, свързани с потребител/сесия. Тестов
  профил не получава owner write права.
- Има TLS проверка към OpenSearch, CSP, HSTS, забрана за cross-origin browser
  достъп, rate limiting, HttpOnly/Secure/SameSite cookies и входна валидация.
- Генерираните `node_modules`, Python `venv` и `server.log` вече не се следят в
  Git. Това отстранява основния дефект от стария одит.

### Какво е опасно

Няма открит P0 дефект. Има три P1 риска:

1. няма доказан OpenSearch backup и restore;
2. стар статичен MCP Bearer token още дава owner достъп без OAuth scopes;
3. реалните owner интеграции не са проверени край до край в личните акаунти.

### Готовност за един реален потребител

Системата е **условно готова за ежедневен чат, четене, търсене и контролирани
интеграции за един човек**. Постоянният запис вече е защитен с еднаква
еднократна потвърдителна граница през чата и API, но системата не трябва да бъде
единственото незаменимо място за лична памет, докато не се докаже restore.
Изтриването и външните write действия остават човешки потвърждавани, а одитът
трябва да стане устойчив преди по-широка автономност.

## Проверена архитектура и поток

1. DigitalOcean App Platform публикува `main` и стартира `node server.js`.
2. Express обслужва мобилния клиент от `public/` и защитава частните маршрути
   чрез GitHub owner или Supabase tester сесия.
3. `POST /chat` зарежда памет и история от OpenSearch, планира способностите през
   Agent Planner/Capability Engine и използва OpenAI Responses API за крайния
   разговорен отговор.
4. Tool Registry декларира способностите, Capability Engine проверява runtime
   наличност и permission policy, а адаптерът изпълнява реалната заявка.
5. Профилната памет и разговорите се пазят в отделни OpenSearch индекси и всяка
   заявка включва `ownerId`.
6. Същите разрешени инструменти са изложени към ChatGPT през `/mcp`; discovery и
   OAuth endpoints са публични, а `tools/call` е защитен.

SYNCHRON-X вече може да бъде собствено работно място, а ChatGPT — външен клиент
към същите инструменти. Това не пренася автоматично ChatGPT Memory, Projects,
Library или други вътрешни ChatGPT данни в SYNCHRON-X.

## Потвърдени защити

- `server.js`: частните маршрути са зад `requireOwnerSession`; owner-only
  интеграциите имат и `requirePrimaryOwner`.
- `src/middleware/ownerAuth.js`: GitHub owner и Supabase tester identities се
  преобразуват към различни стабилни namespaces.
- `src/services/memoryService.js`: list/save/delete/conversation заявки
  филтрират по `ownerId`; exact delete използва и конкретни `_id` стойности.
- `src/config/opensearch.js`: TLS certificate verification не може да бъде
  изключена в production.
- `src/routes/mcpOAuthRouter.js`: OAuth consent POST сравнява Strict CSRF cookie
  и form token; token endpoint е rate-limited.
- `src/services/mcpOAuthService.js`: issuer, audience, expiration, role и scopes
  се проверяват; authorization/refresh grants са еднократни и production replay
  state е устойчив в OpenSearch.
- `.github/workflows/nodejs.yml`: clean install, пълен test script и production
  dependency audit преди merge.
- `.github/workflows/production-smoke.yml`: точният commit трябва да бъде видян
  пет последователни пъти и после минават реалните production проверки.

## Констатации

### SX-01 — Backup и restore на OpenSearch не са доказани

- **Критичност:** P1 висока.
- **Доказателство:** PR №162 добави read-only backup инвентар към съществуващия
  DigitalOcean audit и production smoke е зелен на exact merge commit. Наличната
  защитена браузърна сесия обаче няма owner вход, затова реалният API резултат
  още не е наблюдаван. Няма restore workflow/runbook или доказано
  възстановяване от архив; задача №161 остава отворена.
- **Реален проблем:** повреда, погрешно изтриване или загуба на клъстера може да
  унищожи личната памет, OAuth сесиите, потвържденията и audit/replay индексите.
- **Проверка:** първо изпълни owner-защитения read-only DigitalOcean audit и
  потвърди брой/период на restore точките без идентификатори или съдържание.
  После, само след цена и изрично разрешение, създай временен restore/fork,
  провери mappings и изолиран test owner и унищожи временния клъстер.
- **Поправка:** документиран restore runbook, периодична проверка на наличните
  архиви и контролиран restore drill поне след промяна на storage схемата.
- **Риск от поправката:** среден — restore създава платен ресурс и грешен endpoint
  може да насочи приложението към тестовия клъстер. Не променяй production
  connection по време на проверката.
- **Трудност:** средна.

### SX-02 — Еднократното потвърждение за постоянен запис е отстранено

- **Състояние:** затворена констатация, не активен риск. Поправена с PR №159 и
  допълнително доказана през реалния chat route с PR №160.
- **Доказателство:** `src/services/memoryWriteConfirmationService.js` свързва
  точните факти, scope, хеширан owner и session с устойчиво потвърждение,
  използва кратък TTL и consume-before-write. `POST /memory/profile` връща 409 и
  не записва преди confirmation ID. `POST /chat` не записва implicit факти;
  явната команда само подготвя точния запис. `tests/memoryWriteRoute.test.js`
  минава през реалния Express route и доказва „обикновен текст → 0 записа“,
  „Запомни… → 0 записа + предложение“ и „точно еднократно потвърждение → 1
  запис“.
- **Историческа бележка:** рискът при DELETE API и process-local pending
  delete вече е отстранен с PR №165. Текущата реализация е описана в SX-05 и
  не трябва да се отчита повторно като активен риск.

- **Повторна проверка:** пази route теста, owner/session mismatch тестовете,
  replay теста и production smoke като задължителни регресионни граници.

### SX-03 — Legacy MCP Bearer token заобикаля OAuth scopes

- **Критичност:** P1 висока.
- **Доказателство:** `src/routes/mcpRouter.js`, `requireMcpAuthorization`, първо
  сравнява `MCP_ACCESS_TOKEN` и при съвпадение задава
  `mode=legacy-static-bearer`, `role=owner` и основния `MEMORY_OWNER_ID`.
  `requiredScopesForMcpTool` се прилага само в OAuth пътя. Същата environment
  стойност е root материал за OAuth ключовете в
  `src/services/mcpOAuthService.js` (`oauthSecret`/`grantSecret`).
- **Реален проблем:** изтичане на един дългоживеещ token дава директен read
  достъп до личната памет и owner tool surface, а също компрометира текущото
  OAuth cryptographic root. Няма individual client revocation или scope
  ограничение за legacy клиента.
- **Проверка:** в изолирана test среда извикай read tool със static bearer и
  потвърди, че не е нужен OAuth access token със `synchron:read`.
- **Поправка:** отдели OAuth signing/grant secret от bridge credential;
  мигрирай вътрешния smoke/bridge към scoped OAuth client credential или
  ограничен service token; след доказана миграция ротирай и премахни legacy
  owner fallback.
- **Риск от поправката:** висок — преждевременно премахване може да прекъсне
  production bridge и да обезсили всички съществуващи OAuth tokens.
- **Трудност:** средна.

### SX-04 — Реалните owner интеграции не са доказани край до край

- **Критичност:** P1 висока като verification gap, не доказан кодов дефект.
- **Доказателство:** production smoke доказва MCP catalog/OAuth challenge, но не
  регистриране на приложението в реалния ChatGPT профил, consent, refresh след
  deployment и истинско tool call с owner identity. GitHub и Google тестовете
  използват mocks; няма production доказателство за owner GitHub write или
  Drive/Gmail/Calendar flow. Calendar write кодът е публикуван, но реално
  събитие не е създавано без точно потвърждение.
- **Реален проблем:** конфигурация, provider policy, callback URL, consent scope
  или account permission може да се провали едва при реалния потребител.
- **Проверка:** на computer web добави `https://synchron.foundation/mcp` в
  ChatGPT Developer mode, влез в SYNCHRON-X, извикай read-only system tool,
  рестартирай/изчакай deployment и провери refresh. Отделно изпълни малък
  GitHub write в test branch и Google event в тестов календар — само след
  точните потребителски потвърждения.
- **Поправка:** кратки owner acceptance сценарии с screenshots/run IDs, без
  съхраняване на tokens и без автоматично изпращане/публикуване.
- **Риск от поправката:** среден — тестовете могат да създадат външни данни;
  използвай ясни test ресурси и cleanup.
- **Трудност:** средна.

### SX-05 — Устойчивото потвърждение за memory delete е отстранено

- **Състояние:** затворена констатация, не активен риск. Поправена с PR №165.
- **Доказателство:** `memoryDeleteConfirmationService.js` използва криптираната
  durable confirmation услуга, owner/session/target binding, кратък TTL и
  consume-before-delete. Старият process `Map` и повторяемият HTTP header са
  премахнати. Route тест симулира restart и replay, а production startup
  acceptance run `30650175520` доказва реален изолиран OpenSearch delete и
  непроменена лична памет.
- **Повторна проверка:** пази restart/replay, owner/target mismatch, API/UI и
  production acceptance тестовете като задължителна регресионна граница.

### SX-06 — Audit записът е best-effort и може да липсва след успешно действие

- **Критичност:** P2 средна.
- **Доказателство:** `src/services/taskExecutionService.js`, `safeAudit`, поглъща
  всяка грешка. `src/services/permissionService.js`, `recordAuditEvent`, използва
  process fallback само когато няма OpenSearch client; при наличен client и
  неуспешен index хвърля. `memoryRouter.js`, `chat.js` и
  `confirmedActionsRouter.js` също log-ват audit failure и продължават.
- **Реален проблем:** външно действие може да завърши успешно без устойчив
  журнал. При инцидент няма пълно доказателство кой, какво и кога е изпълнил.
- **Проверка:** симулирай OpenSearch audit index failure и успешно adapter
  действие; тестът `taskExecutionService.test.js` изрично доказва, че крайният
  task остава successful.
- **Поправка:** за write действия използвай durable outbox или fail-closed
  pre-execution audit + отделен final outcome; alert при недоставен audit.
- **Риск от поправката:** среден — fail-closed audit може да блокира полезни
  действия при кратък OpenSearch проблем.
- **Трудност:** средна.

### SX-07 — Concurrent записи по една memory тема могат да създадат дубликати

- **Критичност:** P2 средна.
- **Доказателство:** `src/services/memoryService.js`, `saveProfileMemory`, прави
  read (`fetchProfileHits`) → избира existing ID → чисти дубликати → `index`.
  Няма deterministic document ID, optimistic concurrency или unique constraint
  върху `(ownerId, memoryKey)`.
- **Реален проблем:** две едновременни заявки за една тема могат и двете да не
  видят existing запис и да създадат два документа. View consolidation скрива
  част от дубликатите, но storage остава двусмислен и по-късно delete/update
  поведението става по-трудно за доказване.
- **Проверка:** пусни много паралелни save заявки за един owner и memoryKey към
  реален test index, после преброй суровите документи.
- **Поправка:** deterministic ID от HMAC/hash на ownerId + memoryKey и atomic
  index/update, или optimistic concurrency с retry.
- **Риск от поправката:** среден — нужна е внимателна миграция на старите IDs и
  точен delete compatibility слой.
- **Трудност:** средна.

### SX-08 — Историята на разговора може да не се запази, без клиентът да разбере

- **Критичност:** P2 средна.
- **Доказателство:** `src/routes/chat.js`, `saveConversationTurnBestEffort`,
  връща `false` при OpenSearch грешка, но повечето call sites не използват
  резултата. Крайният SSE event все пак изпраща `ok: true`.
- **Реален проблем:** човекът вижда успешен отговор, но след refresh разговорът
  може да липсва. Това е подвеждащо за система, която обещава постоянна памет.
- **Проверка:** направи OpenSearch conversation index недостъпен след успешен AI
  отговор и провери `done.ok` и последващата history заявка.
- **Поправка:** раздели `answerSucceeded` и `conversationPersisted`; покажи
  видимо „отговорът е получен, но историята не е запазена“ и retry безопасно.
- **Риск от поправката:** нисък.
- **Трудност:** малка.

### SX-09 — Dev/test dependency graph има 23 high предупреждения

- **Критичност:** P2 средна за development/CI, без доказан production impact.
- **Доказателство:** `npm audit --audit-level=high` отчита 23 high през
  `brace-expansion`/`minimatch` в ESLint/Jest/test-exclude веригата и „No fix
  available“. `npm audit --omit=dev --audit-level=high` отчита 0.
- **Реален проблем:** злонамерен/неограничен glob в development или CI може да
  причини memory exhaustion. Production image се изгражда с `npm ci --omit=dev`
  и не включва тази верига.
- **Проверка:** повтори двата audit command-а върху exact lockfile.
- **Поправка:** следи upstream fix; направи отделен dependency PR при налична
  безопасна версия. Не използвай `npm audit fix --force` на production branch.
- **Риск от поправката:** среден — major upgrade може да счупи lint/test tooling.
- **Трудност:** малка след upstream fix, иначе блокирана отвън.

### SX-10 — Единичен app instance и непроверен operational recovery

- **Критичност:** P2 средна.
- **Доказателство:** `.do/app.yaml` задава `instance_count: 1` и малък
  `apps-s-1vcpu-0.5gb` instance. Има readiness/liveness, но няма repo доказана
  rollback процедура, latency/error alert, memory/CPU alert или capacity test.
  Production smoke доказва deployment, не автоматичен rollback.
- **Реален проблем:** process/node/region проблем прекъсва целия сайт; memory
  pressure може да причини рестарти и загуба на in-process state.
- **Проверка:** DigitalOcean metrics, restart history, alert rules, controlled
  failed deployment и rollback timing. Тези platform данни не са проверени.
- **Поправка:** първо alerts и runbook; после измерване. Втори instance само ако
  реалното натоварване/availability го оправдава и след премахване на process
  state от критичните потоци.
- **Риск от поправката:** среден — повече instances увеличават цена и изваждат
  скрити concurrency проблеми.
- **Трудност:** средна.

### SX-11 — Автоматичните тестове не покриват всички production граници

- **Критичност:** P2 средна.
- **Доказателство:** GitHub Actions run `30650129095` върху head commit
  `08039e2ff160b32790b9031416314f64d2e3f610` изпълнява `npm test` с 382
  теста: 382 успешни, 0 неуспешни и 0 пропуснати. Отделният production smoke
  run `30650175520` е успешен върху merge commit `d5300c52` и доказва
  startup acceptance и изолирания OpenSearch поток. Няма паралелен memory write
  test, restore test, sustained load test, истински provider OAuth test или
  forced restart test.

- **Реален проблем:** regression в concurrency, provider policy, deployment
  lifecycle или capacity може да остане невидима.
- **Проверка:** прегледай test names и production smoke; изпълни отделни test
  environments с краткоживеещи credentials и изолирани owners/resources.
- **Поправка:** малък acceptance suite: restart/refresh, concurrent same-key
  save, owner/tester isolation, OAuth provider, audit outage и restore drill.
- **Риск от поправката:** нисък, ако тестовите ресурси са изолирани; среден за
  външни write тестове.
- **Трудност:** средна.

### SX-12 — Няколко основни модула са прекалено големи

- **Критичност:** P3 ниска.
- **Доказателство:** `public/app.js` е около 1620 реда,
  `src/routes/chat.js` около 1438, `src/services/digitalOceanService.js` около
  1048, `memoryService.js` около 829 и `copilotTaskService.js` около 844.
- **Реален проблем:** review-ът е по-труден, границите се смесват и малка
  промяна по-често засяга несвързан поток.
- **Проверка:** измери function/module size и dependency fan-in; провери кои
  части се променят заедно в последните PR-и.
- **Поправка:** постепенно отделяне по доказани граници — chat memory flow,
  provider adapters, UI drawers — само когато се прави следваща реална промяна.
- **Риск от поправката:** среден — голям refactor без продуктова причина може да
  внесе повече дефекти от ползата.
- **Трудност:** голяма, ако се прави наведнъж; малка на итерации.

### SX-13 — Operational документацията изостава от текущия production

- **Критичност:** P3 ниска.
- **Доказателство:** `AGENTS.md` и `docs/TECHNICAL_AUDIT_2026-07-31.md` още
  посочват стари commits и тестови бройки. Няма единен incident/restore runbook.
- **Реален проблем:** следващ оператор или агент може да вземе решение върху
  остаряло състояние и да повтори вече завършена работа.
- **Проверка:** сравни документите с `git rev-parse main`, package tests и
  последния production smoke status.
- **Поправка:** генерирай кратък current-state раздел от проверими endpoints и
  пази runbook отделно от историческия audit.
- **Риск от поправката:** нисък.
- **Трудност:** малка.

## API и security оценка

- **Валидация:** chat, memory, OAuth и adapter входовете имат type/length/scope
  ограничения. Memory fact е ограничен до 500 знака, list limits са capped.
- **Rate limiting:** OAuth, private API и paid AI имат отделни 15-минутни лимити.
  Store е process-local; при повече instances лимитът няма да е глобален.
- **CORS/CSRF:** server не включва cross-origin browser access. Session cookies
  са Secure/HttpOnly/SameSite=Lax; MCP consent използва SameSite=Strict CSRF
  cookie. OAuth provider flows имат state. Не е намерен доказан cross-site POST
  exploit при текущата конфигурация.
- **XSS:** има CSP и DOMPurify тестове за AI Markdown. Inline styles остават
  разрешени от CSP, но scripts са ограничени до self и jsDelivr.
- **SSRF:** основните provider URLs са конфигурационно ограничени; MCP CIMD
  проверката приема само разрешени HTTPS/OpenAI домейни. Не е намерен общ
  arbitrary URL fetch от публичен вход.
- **Injection:** OpenSearch заявките използват structured DSL и keyword terms;
  не се сглобяват query-string изрази от потребителски текст.
- **Secrets:** `.do/app.yaml` маркира частните стойности като `SECRET`; UI
  inventory показва само име/предназначение/status. Публичните Supabase URL и
  publishable key не са service-role тайни. В одита не са копирани secret
  стойности.

## OpenSearch оценка

- Индексите се създават/надграждат чрез explicit mappings.
- `ownerId`, scope, memoryKey и sessionId са keyword полета; conversation
  content не се индексира.
- Exact delete първо намира точните записи и после deleteByQuery филтрира по
  owner и `_id`.
- Full delete също филтрира по owner и optional valid scope.
- Startup acceptance използва отделен `memory-self-test:<owner>:<uuid>` owner,
  доказва write/read/update/delete и сравнява fingerprint на истинската памет
  преди/след cleanup.
- TLS certificate verification е задължителна в production.
- Няма доказан snapshot/restore, shard/replica sizing, retention политика,
  storage alert или capacity limit. Те остават „Не е проверено“.

## Наблюдение и deployment

- `/health` публикува commit и liveness; `/health/ready` изисква memory startup
  proof и bridge readiness.
- Production smoke чака exact commit и публикува commit status
  `synchron/production-smoke`.
- Workflow има 12-минутен timeout и retries за публичните проверки.
- Няма автоматично repo доказан rollback при failed smoke. Deployment failure
  се вижда, но връщането изисква отделно действие.
- Логовете използват error codes в много защитени пътища, но на места печатат
  целия Error object. Не е видяно умишлено логване на tokens; runtime log
  redaction от DigitalOcean не е проверено.

## Какво да се оправи сега

1. **SX-01:** доказан OpenSearch restore — след изрично разрешение за временния
   платен клъстер и точен cost ceiling.
2. **SX-03:** план за миграция и ротация на legacy MCP static bearer, без да се
   прекъсне текущата ChatGPT/OAuth връзка.
3. **SX-04:** реален owner acceptance на ChatGPT MCP, GitHub и Google — всяко
   write действие само с точно потвърждение.
4. **SX-06:** устойчив audit за реалните write действия преди разширяване на
   автономността.

## Какво да се оправи по-късно

1. **SX-07:** atomic/deterministic memory upsert.
2. **SX-08:** видим status при незапазена conversation history.
3. **SX-09:** upgrade на dev tooling, когато upstream има безопасна версия.
4. **SX-10:** alerts, recovery drill и измерване на capacity.
5. **SX-11:** допълнителни restart/concurrency/provider acceptance тестове.
6. **SX-13:** текущ state и incident runbook.

## Какво не е нужно сега

- пренаписване на Node/Express приложението от нулата;
- Kubernetes, microservices или message bus за един реален потребител;
- втори AI provider преди основните owner acceptance тестове;
- повече instances преди измерване и премахване на критичния process state;
- автоматични плащания, резервации или изпращане без човешко потвърждение;
- токенизация, фондация или масова multi-tenant архитектура.

## Какво не е проверено

- DigitalOcean CPU, RAM, restart history, runtime logs, alert rules, firewall и
  реален месечен разход;
- OpenSearch backup schedule, snapshot съдържание, retention, storage usage,
  shard/replica topology и restore;
- Cloudflare dashboard policy, WAF/rate rules и origin exposure;
- GitHub branch protection/ruleset за `main`;
- реален ChatGPT Developer mode app registration в owner профила;
- реални owner OAuth сесии и write действия в GitHub/Google;
- Supabase dashboard policies/advisors към този exact commit;
- production load, latency percentiles и поведение при едновременни потребители.

## Нужен достъп или реален тест

- read-only DigitalOcean metrics/logs и OpenSearch cluster metadata;
- изрично разрешен временен restore cluster с максимална часова цена и
  незабавно изтриване след теста;
- computer web owner session за еднократното ChatGPT MCP registration;
- точни user confirmations за test GitHub branch/PR и test Calendar event;
- временни изолирани owners/index prefix за concurrency и restart acceptance.

## Предложен безопасен ред

1. Прегледай този audit; не сливай автоматично.
2. Пази поправката на SX-02 чрез route/replay regression tests и production
   smoke; не прави нови записи в реалната памет при проверката.
3. След затворения durable memory delete продължи със SX-06, защото повече
   write възможности изискват надежден журнал.
4. Owner read-only ChatGPT MCP acceptance; после refresh-after-deploy test.
5. Owner GitHub/Google write acceptance само с точни тестови ресурси и cleanup.
6. Платен restore drill само след cost approval; не пренасочвай production.
7. Legacy MCP migration/rotation след доказано използване на OAuth клиента.
8. Concurrency/history/operations подобрения по отделни малки PR-и.

Този документ е само одит. Не прави автоматично описаните поправки и не променя
production конфигурация, тайни или данни.
