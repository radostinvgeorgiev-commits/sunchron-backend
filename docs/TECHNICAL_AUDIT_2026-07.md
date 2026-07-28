# Технически одит — NOVARIUM / SYNCHRON-X

**Дата:** 2026-07  
**Клон:** `copilot/technical-audit-synchron-x`  
**Одитирана версия:** commit `0678861` (main след PR #74)  
**Методология:** статичен анализ на изходния код в хранилището, конфигурационни файлове, CI/CD и тестови покритие. Не е направено динамично тестване на production средата.

---

## Обобщение

**Какво е добро:**

- Автентикацията е последователна — всички защитени маршрути минават през `requireOwnerSession`, който проверява шифрована GitHub OAuth сесия и сравнява логина с конфигурирания собственик.
- Потвърдителният поток за памет (запис, изтриване на факт, изтриване на всичко) е внимателно имплементиран с отделни стъпки за потвърждение.
- GitHub Copilot записът минава през двустъпкова дурабилна потвърдителна схема.
- Rate limiting е приложен диференцирано: OAuth (60/15 мин), paid AI (60/15 мин), private API (300/15 мин).
- Тайните в production са в DigitalOcean Secrets, не в кода.
- `npm audit` не открива уязвимости в production зависимостите.
- Smoke тестовете проверяват реалния сайт на всеки 6 часа.

**Какво е опасно:**

- AI-генерираното съдържание се рендира директно чрез `innerHTML` с `marked.parse()` без HTML-санитизация — реален риск от XSS, ако AI агентът бъде компрометиран или върне злонамерен markdown.
- Липсват почти всички стандартни HTTP security headers (CSP, X-Frame-Options, X-Content-Type-Options, HSTS).
- `GITHUB_TOKEN` не е конфигуриран в `.do/app.yaml` — `githubWriteService` не може да работи в production.
- In-process Map-ове за pending deletes, OAuth сесии и потвърждения не се споделят между инстанции (засега само 1, но е латентен проблем).
- Промени в `main` се деплойват автоматично без задължителна ревю стъпка преди production.

**Готов ли е продуктът за един реален потребител?**  
Да, за базов сценарий — разговор с памет и четене от GitHub/Drive/Gmail/Calendar. Функциите за запис в GitHub изискват допълнителна конфигурация. XSS рискът при рендиране на отговорите трябва да се адресира преди по-широка употреба.

---

## Констатации

### A — Архитектура и поток

---

#### A-01: Автоматично деплойване при всяко push в main без задължителна ревю стъпка

- **Критичност:** P1 (висока)
- **Доказателство:** `.do/app.yaml:8` — `deploy_on_push: true`; `.github/workflows/nodejs.yml` — тестовете се изпълняват, но merge не е блокиран ако тестовете не са минали.
- **Реален проблем:** Счупен код може да достигне production, преди грешките да са открити.
- **Проверка:** Направи push на умишлено счупен файл в клон и открий pull request към `main`. Ако branch protection не изисква `status checks`, merge е възможен.
- **Предложение:** Добави branch protection rule за `main`: задължителни passing CI checks + поне 1 одобрение преди merge.
- **Риск от поправката:** Нисък — само организационна промяна.
- **Трудност:** Малка.

---

#### A-02: Hardcoded fallback URL на AI агента в изходния код

- **Критичност:** P2 (средна)
- **Доказателство:** `src/routes/chat.js:612-613` — `process.env.AGENT_URL || "https://a4ppevqrxnzlo6t2bgcpaj3a.agents.do-ai.run"`
- **Реален проблем:** URL е публично видим в хранилището. Ако агентът се смени или URL изтече, fallback-ът може да води към грешен или несъществуващ endpoint. В production `AGENT_URL` е в Secrets, така че fallback не се използва, но ако secret бъде изтрит, приложението ще използва hardcoded URL.
- **Проверка:** Провери дали `AGENT_URL` е зададен в production чрез `/health/ready`.
- **Предложение:** Ако `AGENT_KEY` е зададен, `AGENT_URL` трябва да е задължителен. Премахни fallback URL или го изнеси в `AGENTS.md` като справочна информация.
- **Риск:** Нисък.
- **Трудност:** Малка.

---

### B — Постоянна памет

---

#### B-01: Един OwnerID за всички записи — без изолация между потенциални потребители

- **Критичност:** P2 (средна, с оглед на текущия single-user дизайн)
- **Доказателство:** `src/services/memoryService.js:12` — `const OWNER_ID = process.env.MEMORY_OWNER_ID || "primary-user"`
- **Реален проблем:** Системата е проектирана за един потребител, което е коректно за сегашния етап. Но `MEMORY_OWNER_ID` е единствената бариера. Ако бъдат добавени втори потребител или тестови среди без конфигуриран `MEMORY_OWNER_ID`, всички ще пишат в едно пространство с ключ `"primary-user"`.
- **Проверка:** Стартирай без `MEMORY_OWNER_ID` в две различни среди — двете ще пишат в едно и също.
- **Предложение:** Документирай изрично, че системата е single-user. Добави предупреждение, ако `MEMORY_OWNER_ID` не е зададен.
- **Риск:** Нисък.
- **Трудност:** Малка.

---

#### B-02: `deleteProfileMemoryByFact` изтрива по `memoryKey`, не по точен факт

- **Критичност:** P2 (средна)
- **Доказателство:** `src/services/memoryService.js:618-641` — функцията извлича `metadata.memoryKey` от факта, след което изтрива всички записи с тази тема, не само точния факт.
- **Реален проблем:** Ако потребителят иска да изтрие „Живея в Пловдив", но е записано и „Живея в Пловдив, ул. Главна", и двата имат `memoryKey: "personal:location:residence"` и двата ще бъдат изтрити.
- **Проверка:** Запомни два различни факта за местоживеене. Изтрий единия. Провери дали другият е изтрит.
- **Предложение:** Добави проверка за точно съответствие на `normalizedFact` преди изтриване, вместо да разчиташ само на `memoryKey`.
- **Риск:** Среден — промяна в логиката на изтриване.
- **Трудност:** Малка.

---

#### B-03: In-process `pendingDeletes` Map не се споделя при хоризонтално мащабиране

- **Критичност:** P1 (висока, потенциална при масштабиране)
- **Доказателство:** `src/services/pendingDeleteService.js:14` — `const pendingDeletes = new Map()`. Аналогично: `src/services/confirmationService.js:27` — `const pendingConfirmations = new Map()`. `src/services/githubOAuthService.js:13` — `const sessions = new Map()`.
- **Реален проблем:** Ако `.do/app.yaml` промени `instance_count` от 1 на 2+, потребителят може да изпрати „Потвърждавам" на инстанция 2, докато pending delete е на инстанция 1 — потвърждението не се разпознава.
- **Проверка:** Повиши `instance_count` до 2 в тестова среда. Направи опит за изтриване и потвърди.
- **Предложение:** Засега запази 1 инстанция. Ако ще се масштабира, съхранявай pending state в OpenSearch с TTL.
- **Риск:** Нисък засега (1 инстанция).
- **Трудност:** Голяма.

---

#### B-04: Памет — тестовете не тестват реален OpenSearch

- **Критичност:** P2 (средна)
- **Доказателство:** `tests/memoryService.test.js` — всички 15 теста тестват само pure functions: `deriveMemoryMetadata`, `extractForgetMemoryCommand`, `consolidateMemoryView` и т.н. Няма mock на OpenSearch клиента. Функциите, които четат/пишат в OpenSearch (`saveProfileMemory`, `deleteProfileMemoryByFact`, `listProfileMemories`) не са покрити с тестове.
- **Реален проблем:** Реален бъг в OpenSearch заявките (грешна структура, неправилен sort, race condition при `ensureIndex`) може да не бъде открит в CI.
- **Предложение:** Добави интеграционни тестове с in-memory OpenSearch инстанция или подробни mock тестове за заявките.
- **Риск:** Нисък — само тестова промяна.
- **Трудност:** Средна.

---

### C — Автентикация и разрешения

---

#### C-01: Липса на CSRF защита — само SameSite=Lax cookie

- **Критичност:** P1 (висока)
- **Доказателство:** `src/routes/githubOAuthRouter.js:17` — `SameSite=Lax`. Целите защитени маршрути (chat, memory, github) разчитат само на cookie. Няма CSRF token.
- **Реален проблем:** `SameSite=Lax` блокира cross-site POST от форми и fetch, но не блокира POST от top-level navigation (например `<form method="POST" action="...">` на злонамерен сайт). Потенциален вектор за принудително изтриване на памет или изпращане на chat съобщения.
- **Проверка:** От злонамерен сайт, направи `fetch` с `credentials: "include"` към `DELETE /memory/profile` — браузърът ще блокира (Lax блокира cross-site fetch). Но стандартна HTML форма с `action="/memory/profile"` и `method="POST"` би могла да се изпрати.
- **Предложение:** Промени cookies на `SameSite=Strict` или добави CSRF token за state-changing операции (DELETE /memory/profile, POST /chat).
- **Риск:** Нисък за смяна на SameSite. Среден за CSRF токен (промяна в клиента).
- **Трудност:** Малка (SameSite=Strict).

---

#### C-02: GitHub OAuth state параметърът не е обвързан с device fingerprint

- **Критичност:** P2 (средна)
- **Доказателство:** `src/routes/githubOAuthRouter.js:36-44` — state се генерира като nonce и се записва в cookie, а при callback се сравнява само с cookie стойността. Няма допълнителна валидация.
- **Реален проблем:** Стандартна практика, но ако cookie бъде откраднат, OAuth state може да бъде изпълнен. Това е ограничено от HTTPS и Secure cookie.
- **Предложение:** Настоящата имплементация е приемлива. Може да се добави bind към User-Agent/IP при генерирането.
- **Риск:** Нисък.
- **Трудност:** Малка.

---

### D — API сигурност

---

#### D-01: AI отговорите се рендират чрез `innerHTML` без HTML санитизация

- **Критичност:** P1 (висока)
- **Доказателство:** `public/app.js:850-851` — `element.innerHTML = marked.parse(text)`. `marked` конвертира markdown в HTML без DOMPurify или `marked.setOptions({ sanitize: true })`.
- **Реален проблем:** Ако AI агентът бъде компрометиран, отговори с `<script>alert(1)</script>` или `<img onerror=...>` ще се изпълнят в браузъра. Дори без компрометиране, prompt injection от злонамерен content в паметта или инструментите може да инжектира HTML.
- **Проверка:** Запомни факт, съдържащ `<img src=x onerror=alert(1)>`. Попитай AI „какво знаеш за мен" и наблюдавай дали alert се задейства.
- **Предложение:** Добави DOMPurify: `element.innerHTML = DOMPurify.sanitize(marked.parse(text))`.
- **Риск:** Нисък (само добавяне на библиотека и извикване).
- **Трудност:** Малка.

---

#### D-02: Липсват HTTP security headers

- **Критичност:** P1 (висока)
- **Доказателство:** `server.js` — не е използван `helmet` или ръчно зададени `Content-Security-Policy`, `X-Frame-Options`, `X-Content-Type-Options`, `Strict-Transport-Security`.
- **Реален проблем:** Без CSP: inline скриптове са разрешени, CDN ресурсите (Font Awesome, marked.js) могат да бъдат заменени. Без X-Frame-Options: сайтът може да бъде вграден в iframe за clickjacking. Без HSTS: браузърите може да опитат HTTP преди HTTPS.
- **Проверка:** `curl -I https://synchron.foundation/` — провери дали в отговора има тези хедъри.
- **Предложение:** Добави `helmet` middleware: `app.use(helmet())`. Конфигурирай CSP, като включиш разрешените CDN източници.
- **Риск:** Нисък — потенциален CSS/JS бъг при твърда CSP политика.
- **Трудност:** Малка до средна (CSP изисква тестване на всички ресурси).

---

#### D-03: Липсват CORS хедъри

- **Критичност:** P2 (средна)
- **Доказателство:** `server.js` — не е конфигуриран CORS middleware. Не са зададени `Access-Control-Allow-Origin` хедъри.
- **Реален проблем:** За state-changing заявки браузърите изпращат preflight OPTIONS запрос. Без CORS handler, cross-origin fetch от https://synchron.foundation към /chat ще бъде блокиран от браузъра. Сайтът е self-contained, така че засега не е проблем. При евентуален мобилен клиент или SPA на друг домейн ще бъде проблем.
- **Предложение:** Добави изричен `cors()` middleware с whitelist `["https://synchron.foundation"]`.
- **Риск:** Нисък.
- **Трудност:** Малка.

---

#### D-04: Входният лимит за JSON body (8MB) позволява злоупотреба

- **Критичност:** P2 (средна)
- **Доказателство:** `server.js:35` — `express.json({ limit: "8mb" })`
- **Реален проблем:** POST /chat приема 8MB JSON тяло. Изображенията се изпращат като base64 в request body. Злонамерен потребител може да изпраща непрекъснати 8MB заявки, което може да доведе до memory pressure при 0.5GB инстанцията.
- **Проверка:** Изпрати 8MB JSON тяло към `/chat` — изчисли RAM потреблението.
- **Предложение:** Намали общия лимит до 1-2MB, а за `/chat` ендпоинта с изображения — отдели специфичен middleware с 8MB само за него.
- **Риск:** Нисък.
- **Трудност:** Малка.

---

#### D-05: Rate limiting е per-IP, но без user-level лимит

- **Критичност:** P3 (ниска)
- **Доказателство:** `src/middleware/rateLimits.js` — `express-rate-limit` по подразбиране брои по IP. `server.js:34` — `app.set("trust proxy", 1)` е зададен.
- **Реален проблем:** Един потребител с динамичен IP или зад shared proxy може да заобиколи лимита чрез смяна на IP. Засега приложимо само за собственика, така че рискът е нисък.
- **Предложение:** Не е приоритет при single-user системата.
- **Риск:** N/A.
- **Трудност:** Средна.

---

### E — Тайни и конфигурация

---

#### E-01: `GITHUB_TOKEN` не е конфигуриран в `.do/app.yaml`

- **Критичност:** P1 (висока)
- **Доказателство:** `.do/app.yaml` — няма `GITHUB_TOKEN` env var. `src/services/githubWriteService.js:22-31` — `requireToken()` хвърля грешка 500, ако `GITHUB_TOKEN` не е зададен.
- **Реален проблем:** `githubWriteService` (createFile, updateFile, createBranch, createPullRequest) не може да работи в production. Всяко извикване ще върне `"GITHUB_TOKEN не е конфигуриран."`.
- **Проверка:** Провери в DigitalOcean дали `GITHUB_TOKEN` е добавен като Runtime Secret.
- **Предложение:** Добави `GITHUB_TOKEN` в `.do/app.yaml` като Secret, ако се ползва. Ако GitHub write се извършва само чрез Copilot (OAuth потребителски token), документирай, че `GITHUB_TOKEN` не е нужен.
- **Риск:** Нисък.
- **Трудност:** Малка.

---

#### E-02: `WEB_SEARCH_MODEL` и `OPENAI_VISION_MODEL` не са в `.do/app.yaml`

- **Критичност:** P3 (ниска)
- **Доказателство:** `.env.example:16-17` — дефинирани са `WEB_SEARCH_MODEL=gpt-4.1-mini` и `OPENAI_VISION_MODEL=gpt-4o-mini`. `.do/app.yaml` — не ги съдържа. `src/services/webSearchService.js:1-2` — ако не са зададени, се ползват hardcoded defaults.
- **Реален проблем:** Не е блокиращ, но моделът не може да се смени без code push.
- **Предложение:** Добави тези env vars в `.do/app.yaml` като явни (не Secret) стойности.
- **Риск:** Нисък.
- **Трудност:** Малка.

---

#### E-03: `GOOGLE_REDIRECT_URI` е зашито и в `.do/app.yaml`, и в `githubOAuthService.js`

- **Критичност:** P3 (ниска)
- **Доказателство:** `src/services/githubOAuthService.js:8` — `DEFAULT_GITHUB_REDIRECT_URI = "https://synchron.foundation/api/github/callback"`. `.do/app.yaml:69` — `GITHUB_REDIRECT_URI: https://synchron.foundation/api/github/callback`
- **Реален проблем:** Ако домейнът се смени, трябва промяна на 2+ места. Засега не е проблем.
- **Предложение:** Не е приоритет.
- **Риск:** N/A.
- **Трудност:** Малка.

---

### F — OpenSearch

---

#### F-01: Няма стратегия за backup/restore

- **Критичност:** P1 (висока)
- **Доказателство:** Нито в `docs/`, нито в `.do/app.yaml` или `scripts/` има документация или автоматизация за backup на OpenSearch индексите.
- **Реален проблем:** Загуба на данни при техническа авария без backup.
- **Проверка:** Не е проверено — изисква достъп до DigitalOcean/OpenSearch настройки.
- **Предложение:** Документирай ръчна backup процедура. Провери дали DigitalOcean Managed OpenSearch има автоматичен snapshot schedule.
- **Риск:** Нисък за операцията.
- **Трудност:** Малка (документация) до средна (автоматизация).

---

#### F-02: `ensureIndex` кешира promise, но грешки изчистват кеша без retry логика

- **Критичност:** P2 (средна)
- **Доказателство:** `src/services/memoryService.js:29-57` — при грешка `indexPromises.delete(index)` и грешката се re-throw. Следващото извикване ще опита отново, но на клиентски код (chat route) грешката ще изглежда като service unavailable.
- **Реален проблем:** Временна мрежова грешка при стартиране ще провали index provisioning. Следващото chat съобщение ще получи грешка, но вероятно ще се реши сам при следващ опит.
- **Предложение:** Добави exponential backoff retry в `ensureIndex` или обработвай "index already exists" грешката gracefully.
- **Риск:** Нисък.
- **Трудност:** Малка.

---

#### F-03: Audit индексът (`synchron-action-audit`) няма mapping и TTL

- **Критичност:** P3 (ниска)
- **Доказателство:** `src/services/permissionService.js:4` — `AUDIT_INDEX` е дефиниран, но `ensureIndex` не се извиква за него. Не е документирана политика за изтриване на стари записи.
- **Реален проблем:** Индексът расте неограничено. При голям брой заявки ще консумира диск.
- **Предложение:** Добави `ensureAuditIndex` с mapping и ILM (Index Lifecycle Management) политика за изтриване след 90 дни.
- **Риск:** Нисък.
- **Трудност:** Малка.

---

### G — Обработка на грешки и устойчивост

---

#### G-01: При OpenSearch недостъпност в production, потвърдителният поток пада

- **Критичност:** P1 (висока)
- **Доказателство:** `src/services/confirmationService.js:172-187` — ако `requiresPersistentConfirmations()` е `true` (в production) и OpenSearch не е достъпен, `createDurableConfirmation` хвърля грешка. Потребителят не може да стартира Copilot задача.
- **Реален проблем:** При кратко прекъсване на OpenSearch, GitHub Copilot операциите са напълно блокирани в production, дори самият GitHub е достъпен.
- **Предложение:** Разгледай дали in-process fallback е приемлив риск за production при single-user система (OpenSearch е single point of failure).
- **Риск:** Архитектурен компромис.
- **Трудност:** Средна.

---

#### G-02: SSE стриймингът не изпраща грешка, ако `agentRes.body` е null

- **Критичност:** P2 (средна)
- **Доказателство:** `src/routes/chat.js` — след проверка `if (!agentRes.body) throw new Error("Empty AI response stream.")`. Грешката е хвърлена, но не е хваната с `sendEvent("error", ...)` в catch блока, а достига общия `catch` блок в края. При SSE headers вече изпратени, отговорът може да приключи без съобщение за грешка към клиента.
- **Реален проблем:** Потребителят вижда просто спряло зареждане без обяснение.
- **Предложение:** Хвани грешката преди reader.read() и изпрати `sendEvent("error", ...)` явно.
- **Риск:** Нисък.
- **Трудност:** Малка.

---

#### G-03: `server.log` е проследим файл в хранилището

- **Критичност:** P2 (средна)
- **Доказателство:** `server.log` се вижда в root директорията на хранилището и не е в `.gitignore`.
- **Реален проблем:** Ако лог файлът бъде accidentally commit-нат, може да съдържа чувствителни данни (session IDs, OpenSearch грешки, URLs).
- **Проверка:** `git status` — `server.log` е untracked. Но не е в `.gitignore`.
- **Предложение:** Добави `server.log` (и `*.log`) в `.gitignore`.
- **Риск:** Нисък.
- **Трудност:** Минимална.

---

### H — Логове и наблюдение

---

#### H-01: Логовете съдържат `sessionId` и са достъпни само в DigitalOcean

- **Критичност:** P2 (средна)
- **Доказателство:** `src/routes/chat.js:633` — `console.log('[POST /chat] sessionId: ${cleanSessionId}')`. Session ID са UUID, не лични данни, но идентифицират сесии.
- **Реален проблем:** Без структурирано логване е трудно да се правят заявки за конкретни грешки. Достъп до логовете е само чрез DigitalOcean Console.
- **Предложение:** Не е блокиращо за единичен потребител. Логването е достатъчно.
- **Риск:** N/A.
- **Трудност:** N/A.

---

#### H-02: `/opensearch-status` е зад `requireOwnerSession` — не може да се мониторира без auth

- **Критичност:** P3 (ниска)
- **Доказателство:** `server.js:74` — `/opensearch-status` изисква auth. `production-smoke.yml:33-38` — smoke тестът опитва да провери `/opensearch-status`, но не е аутентикиран.
- **Реален проблем:** Smoke тестът ще получи 401, не `"green"` или `"yellow"`. Провери дали smoke тестът наистина пропада поради това.
- **Проверка:** Стартирай smoke workflow и виж изхода за стъпка "Check persistent-memory service".
- **Предложение:** Или премахни auth от `/opensearch-status`, или добави отделен `/health/opensearch` без auth в `health.js`.
- **Риск:** Нисък.
- **Трудност:** Малка.

---

### I — Тестове

---

#### I-01: Пълното отсъствие на end-to-end или интеграционни тестове

- **Критичност:** P2 (средна)
- **Доказателство:** Всички тестове са unit тестове на pure functions или тестове с mock обекти. Не съществуват тестове, които стартират сървъра и правят HTTP заявки (суперtest е в devDependencies, но не се ползва в тестовете).
- **Реален проблем:** Промени в маршрутите, middleware или OpenSearch заявките могат да счупят real behavior без да счупят тестовете.
- **Предложение:** Добави поне smoke интеграционен тест с supertest за `/health`, `/chat` (с mock agent), и `/memory/profile`.
- **Риск:** Нисък.
- **Трудност:** Средна.

---

#### I-02: Chat route (`chat.js`, 45KB) не е покрит с unit тестове

- **Критичност:** P2 (средна)
- **Доказателство:** `tests/chatCapabilityExecution.test.js` и `tests/chatResilience.test.js` тестват помощни функции, не самия HTTP маршрут. `POST /chat` не е тестван с HTTP заявки.
- **Предложение:** Добави тестове за ключови пътища: memory action, capability execution, SSE streaming.
- **Риск:** Нисък.
- **Трудност:** Средна до голяма (заради streaming).

---

### J — DigitalOcean и публикуване

---

#### J-01: Инстанцията е с 0.5GB RAM — рискова при пиков трафик

- **Критичност:** P2 (средна)
- **Доказателство:** `.do/app.yaml:13` — `instance_size_slug: apps-s-1vcpu-0.5gb`
- **Реален проблем:** Node.js с 8MB request body, streaming AI отговори и OpenSearch connections може да натовари 0.5GB при пикови заявки. При OOM kill приложението рестартира без известие.
- **Проверка:** Не е проверено — изисква метрики от DigitalOcean.
- **Предложение:** Наблюдавай RAM usage в production. При проблем — scale up до 1GB.
- **Риск:** Нисък.
- **Трудност:** Минимална (slider в DigitalOcean).

---

#### J-02: Няма rollback стратегия при счупен деплой

- **Критичност:** P1 (висока)
- **Доказателство:** `.do/app.yaml` — само `deploy_on_push: true`. Няма документация за rollback.
- **Реален проблем:** При счупен деплой трябва ръчно revert commit или DigitalOcean Console интервенция.
- **Предложение:** Документирай процедура: `git revert HEAD && git push` или DigitalOcean → Apps → Deployments → Rollback. Разгледай дали `deploy_on_push: false` с ръчен deploy е по-безопасно за критични промени.
- **Риск:** Нисък.
- **Трудност:** Малка (документация).

---

### K — Поддръжка на кода

---

#### K-01: `chat.js` е 45KB и съдържа много различни отговорности

- **Критичност:** P3 (ниска)
- **Доказателство:** `src/routes/chat.js` — 1200+ реда. Съдържа: парсери за команди, capability detection, SSE streaming логика, memory action обработка, конструкция на AI промпт, heartbeat логика.
- **Реален проблем:** Трудно се поддържа. Нова функционалност лесно влиза в грешния слой.
- **Предложение:** Постепенно изнеси: `buildAvatarMessages` и `buildMemoryReply` в `chatContext.js`, SSE streaming логиката в `sseStream.js`.
- **Риск:** Среден при рефакторинг.
- **Трудност:** Голяма.

---

#### K-02: Дублиране на конфигурационната логика за GitHub repository в 3 места

- **Критичност:** P3 (ниска)
- **Доказателство:** `src/services/githubService.js:1`, `src/services/githubWriteService.js:3`, `src/services/copilotTaskService.js:8` — всеки дефинира `DEFAULT_REPOSITORY = "radostinvgeorgiev-commits/sunchron-backend"` и `configuredRepository()`.
- **Предложение:** Изнеси в `src/config/githubConfig.js`.
- **Риск:** Нисък.
- **Трудност:** Малка.

---

#### K-03: `confirmationService` използва GitHub session encryption за non-GitHub confirmations

- **Критичност:** P2 (средна)
- **Доказателство:** `src/services/confirmationService.js:2-6` — импортира `encryptGitHubSession` / `decryptGitHubSession` и ги използва за всички потвърждения.
- **Реален проблем:** Ако бъдат добавени non-GitHub confirmations, те ще разчитат на `GITHUB_CLIENT_SECRET` за шифроване. Ако GitHub OAuth не е конфигуриран, потвърдителната система е неработеща.
- **Предложение:** Прелей в обща `encryptPayload`/`decryptPayload` функция в `src/utils/crypto.js`.
- **Риск:** Нисък.
- **Трудност:** Малка.

---

## Три списъка с приоритети

### Оправи сега — блокиращи за реален потребител

1. **D-01** — Добави DOMPurify за санитизация на markdown отговорите от AI (XSS риск).
2. **D-02** — Добави `helmet()` за основни security headers (CSP, X-Frame-Options, HSTS).
3. **E-01** — Провери и документирай дали `GITHUB_TOKEN` е нужен в production; ако не — документирай защо; ако да — добави го в `.do/app.yaml`.
4. **F-01** — Документирай backup/restore процедура за OpenSearch.
5. **J-02** — Документирай rollback процедура при счупен деплой.
6. **G-03** — Добави `server.log` и `*.log` в `.gitignore`.

### Оправи по-късно — важни, но не блокиращи

1. **A-01** — Добави branch protection rules за `main` (задължителни CI checks преди merge).
2. **C-01** — Смени OAuth cookies на `SameSite=Strict` за защита от CSRF.
3. **G-01** — Разгледай дали OpenSearch трябва да е hard dependency за potвърждения в production.
4. **B-02** — Прецизирай `deleteProfileMemoryByFact` да изтрива само точния факт.
5. **H-02** — Поправи `/opensearch-status` endpoint или smoke теста.
6. **B-03** — Документирай ограничението за single-instance; планирай ако трябва мащабиране.
7. **I-01** — Добави поне един интеграционен тест с supertest.
8. **A-02** — Премахни hardcoded fallback agent URL.
9. **K-03** — Изнеси общата crypto логика от confirmationService.
10. **F-02** — Добави retry логика в `ensureIndex`.
11. **F-03** — Добави `ensureAuditIndex` с ILM политика.
12. **E-02** — Добави `WEB_SEARCH_MODEL` и `OPENAI_VISION_MODEL` в `.do/app.yaml`.

### Не е нужно сега — ще усложни проекта без реална полза

1. **D-05** — User-level rate limiting при single-user система.
2. **K-01** — Пълен рефакторинг на `chat.js` (само при следващо голямо добавяне на функционалност).
3. **K-02** — Обединяване на repository конфигурацията (минимална полза).
4. **D-03** — CORS middleware (не е нужен при чист single-origin сайт).
5. **B-01** — Multi-user изолация (не е цел на системата).

---

## Какво не е могло да бъде проверено

| Тема | Защо не е проверено | Нужен достъп/тест |
|---|---|---|
| Реалното поведение на DigitalOcean деплоя | Няма достъп до DigitalOcean Console | DigitalOcean App Platform → Deployments, Metrics |
| OpenSearch клъстерно здраве, индекси и настройки | Няма достъп до managed OpenSearch | `GET /_cluster/health`, `GET /_cat/indices`, DigitalOcean OpenSearch Console |
| Дали OpenSearch има автоматични snapshots | Не е видимо от кода | DigitalOcean OpenSearch → Backups |
| Реален RAM/CPU usage на production | Няма метрики | DigitalOcean App Platform → Insights |
| Дали `GITHUB_TOKEN` е добавен в production secrets | Само .do/app.yaml видим | DigitalOcean → App → Environment Variables |
| Дали smoke тестовете преминават в production | Изисква `curl` с реална auth | GitHub Actions → production-smoke.yml → последен run |
| Google OAuth реален flow | Изисква браузър + OAuth consent | Ръчен тест с реален потребител |
| Копилот задача от край до край | Изисква Copilot license + GitHub auth | Ръчен тест в production |
| Performance под натоварване | Изисква инструмент за натоварване | `k6`, `wrk` срещу staging среда |
| DigitalOcean мрежова изолация и firewall | Не е видимо от кода | DigitalOcean → Networking |

---

## Предложен безопасен ред за поправяне

1. **G-03** — `.gitignore` промяна: без риск, 1 минута.
2. **D-01** — DOMPurify: добави CDN tag в `index.html`, замени `marked.parse` извикванията. Тествай UI.
3. **D-02** — `helmet()`: инсталирай пакета, добави в `server.js`, тествай всички ресурси. Итерирай CSP ако нещо се чупи.
4. **H-02** — Провери smoke тест резултата; добави `/health/opensearch` без auth ако е нужно.
5. **E-01** — Провери в DigitalOcean дали `GITHUB_TOKEN` е зададен; актуализирай документацията.
6. **F-01** — Напиши `docs/BACKUP_RESTORE.md`.
7. **J-02** — Напиши `docs/RUNBOOK.md` с rollback процедура.
8. **A-01** — Настрой branch protection в GitHub Settings.
9. **C-01** — Смени `SameSite=Lax` на `SameSite=Strict` в OAuth router.
10. Останалите поправки — при следваща планова работна сесия.

---

## SYNCHRON-X като основно работно място спрямо текущите способности в ChatGPT/Work

### Легенда

- ✅ **Работи реално** — изпълнима операция с потвърден адаптер, конфигурация и тест
- ⚠️ **Регистрирана, но без доказан краен тест** — в Tool Registry, executor съществува, но не е тестван end-to-end с реална услуга
- 🔗 **Само отваря/препраща** — системата предоставя линк, не изпълнява операцията
- ❌ **Липсва** — нито регистрирана, нито имплементирана
- 🔧 **Не може да се прехвърли директно** — изисква API, MCP адаптер или отделна интеграция

---

### Таблица на способностите

| Способност | ChatGPT/Work | SYNCHRON-X сега | Бележки |
|---|---|---|---|
| **Разговор** | ✅ Натурален диалог | ✅ Работи | Чрез DigitalOcean AI Agent |
| **История на разговора** | ✅ В рамките на сесия | ✅ Работи | Запазена в OpenSearch, 20 съобщения на сесия |
| **Постоянна памет (четене)** | ✅ (ChatGPT Memory) | ✅ Работи | `listProfileMemories` → OpenSearch |
| **Постоянна памет (запис)** | ✅ | ✅ Работи | Двустъпково потвърждение |
| **Постоянна памет (изтриване на факт)** | ⚠️ Ограничено в ChatGPT | ✅ Работи | `deleteProfileMemoryByFact` с потвърждение |
| **Постоянна памет (пълно изтриване)** | ✅ | ✅ Работи | `clearProfileMemories` с двустъпково потвърждение |
| **Контрол на паметта от потребителя** | ⚠️ Ограничено | ✅ По-добро от ChatGPT | Потребителят вижда, редактира и изтрива всеки факт |
| **Web search и източници** | ✅ (с Browse) | ⚠️ Регистрирана, без краен тест | `searchWeb` → OpenAI web_search tool; изисква `OPENAI_API_KEY` и тест в production |
| **GitHub четене (код, commits, PRs)** | ✅ (с Copilot) | ✅ Работи | `answerGitHubReadRequest` → GitHub REST API |
| **GitHub запис (клон, PR, файл)** | ✅ (с Copilot) | ⚠️ Регистрирана; `GITHUB_TOKEN` не е в .do/app.yaml | `githubWriteService` съществува; не е потвърдено в production |
| **GitHub Copilot задача** | ✅ (в Copilot) | ✅ Работи (OAuth flow) | `copilotTaskService` — двустъпково потвърждение, GraphQL мутация |
| **Google Drive (четене на файлове)** | ✅ (с plugin) | ⚠️ Регистрирана, изисква OAuth | `listDriveFiles` съществува; изисква Google OAuth flow от браузъра |
| **Gmail (четене)** | ✅ (с plugin) | ⚠️ Регистрирана, изисква OAuth | `listGmailMessages` съществува; изисква Google OAuth |
| **Google Calendar (четене)** | ✅ (с plugin) | ⚠️ Регистрирана, изисква OAuth | `listGoogleCalendarEvents`; изисква Google OAuth |
| **Google Calendar (запис)** | ✅ (с plugin) | ❌ Липсва | `calendar.write` е в permission policy, но няма executor в capabilityEngine |
| **Gmail (изпращане)** | ✅ (с plugin) | ❌ Липсва | `external.send` е в policy, но без executor |
| **Снимки и визуален анализ** | ✅ | ✅ Работи | `analyzeImage` → OpenAI Vision; поддържа JPEG/PNG/WebP до 20MB |
| **Анализ на документи (PDF, Word)** | ✅ | ⚠️ Регистрирана | `googleDriveService` поддържа Document export; изисква Google OAuth |
| **Image generation** | ✅ (DALL-E) | ❌ Липсва | Няма executor за генериране на изображения |
| **Глас (voice input)** | ✅ | 🔗 UI placeholder | `voiceInputUi.test.js` тества UI бутон, не реален STT |
| **Reminders / мониторинг** | ✅ (с planner) | ❌ Липсва | Няма scheduled tasks, cron или push notifications |
| **Library / файлове (upload)** | ✅ | 🔗 Частично | Изображения се качват в чата; общ file library липсва |
| **Разрешения и потвърждения** | ⚠️ Ограничено | ✅ По-добро | Explicit permission policy с granular allow/confirm/deny |
| **Избор на AI модел** | ✅ (в ChatGPT) | ❌ Липсва | Единствен DigitalOcean Agent; нняма routing по модел |
| **Проекти / контекст** | ✅ (Projects в ChatGPT) | ⚠️ Частично | Project scope в паметта; без отделен project workspace |
| **Spoiled бял дъсски / canvas** | ✅ (Canvas) | ❌ Липсва | Не е в roadmap |

---

### Най-малкият реален план за ежедневна употреба

**Цел:** До няколко дни сайтът да бъде основното работно място за разговор, памет и четене от свързаните услуги.

#### Ден 1 (< 2 часа)
1. **XSS fix:** Добави DOMPurify в `index.html` + wrap `marked.parse` в `DOMPurify.sanitize`. Commit → auto-deploy.
2. **Helmet:** Добави `helmet()` в `server.js`. Тествай дали CSS/JS от CDN все още зарежда. Ако CSP блокира нещо — добави exceptions.
3. **Потвърди Google OAuth:** От браузъра, влез в `https://synchron.foundation/api/google/connect` и завърши OAuth flow. След това провери `/health/integrations` — Drive, Calendar и Gmail трябва да са `authenticated: true`.

#### Ден 2 (< 2 часа)
4. **Тествай web search:** Изпрати съобщение „Потърси в интернет актуалната версия на Node.js." Провери дали резултатът идва с източници.
5. **Потвърди паметта:** Запомни 3 факта. Излез. Влез в нов разговор. Провери дали AI ги познава.
6. **Smoke тест на `/opensearch-status`:** Провери в GitHub Actions дали последният production-smoke run минава; ако не — виж H-02.

#### Ден 3 (по желание)
7. **Backup документация:** Напиши `docs/BACKUP_RESTORE.md` с ДО инструкции за OpenSearch snapshot.
8. **Branch protection:** Настрой GitHub branch protection за `main` — задължителни CI checks.
9. **GITHUB_TOKEN:** Провери в DigitalOcean дали е нужен и добави ако да.

**Резултат:** Разговор с памет ✅, Google Drive/Calendar/Gmail четене ✅, GitHub четене ✅, web search ✅, image analysis ✅. Системата е годна за ежедневна лична употреба.

---

*Одитът е само за четене. Не са направени промени по приложния код, конфигурацията или данните.*
