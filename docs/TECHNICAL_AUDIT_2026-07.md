# Технически одит на NOVARIUM / SYNCHRON-X

Дата: 31 юли 2026 г.  
Проверен commit: `07abed98916c679c632288c400854a26e14e32cb`  
Обхват: актуалният `main`, наличната конфигурация в хранилището и безопасните публични production проверки.  
Ограничение: одитът не променя приложен код, production конфигурация, тайни или реални данни.

## Кратко обобщение

SYNCHRON-X е готов за внимателна ежедневна употреба от един реален потребител в сегашния си ограничен обхват: сайтът и readiness са зелени, разговорът е защитен зад профил, постоянната памет е изолирана по `ownerId`, опасните GitHub и Calendar действия имат отделни потвърждения, а production smoke доказва точния публикуван commit. Кодът има значително по-добро тестово и security покритие от типичен личен прототип.

Най-опасните оставащи рискове са три:

1. ChatGPT/MCP OAuth кодовете и refresh token-ите зависят от случаен ключ на конкретния Node процес. При rolling deployment или повече от една инстанция свързването и обновяването на token може да отказват.
2. Няма доказан OpenSearch backup и restore. OpenSearch е единична точка на отказ не само за личната памет, а и за Google/GitHub сесии, потвърждения, tester approvals и одитния журнал.
3. Декларираната политика изисква потвърждение за постоянен запис в паметта, но два реални пътя я заобикалят: автоматичният high-confidence запис от чата и директният `POST /memory/profile`.

Оценка: системата е използваема за един човек, но A-01, A-02 и A-03 трябва да се отстранят преди да се разчита на нея като устойчиво основно работно място или да се разширява към повече потребители.

## Потвърдено добро състояние

- Production е стабилен на проверения commit. Осем последователни no-cache `/health` заявки върнаха `07abed98`; официалният `synchron/production-smoke` е успешен: <https://github.com/radostinvgeorgiev-commits/sunchron-backend/actions/runs/30646444214>.
- Публичните проверки потвърдиха сайт, `ready`, изолиран OpenSearch acceptance тест, непроменена реална памет, успешно почистване, MCP bridge, OAuth challenge и tester-auth конфигурация.
- Локалният пакет на точния commit има 383 теста: 382 успешни, 0 неуспешни и 1 пропуснат реален OpenSearch тест.
- `npm audit --omit=dev` отчита 0 production уязвимости.
- Текущото дърво не проследява `node_modules`, Python `venv` или `server.log`; старият доклад за тези генерирани файлове вече не е актуален.
- В текущите проследени файлове не бяха открити стойности, приличащи на private keys, GitHub PAT, OpenAI key, DigitalOcean token или Google API key. Това не е пълен secret scan на цялата Git история.
- TLS проверката за OpenSearch не може да бъде изключена в production (`src/config/opensearch.js:5-18`).
- Паметта използва `ownerId` във всички основни list/delete заявки (`src/services/memoryService.js:381-400`, `633-695`, `698-718`).
- GitHub write е ограничен до конфигурираното хранилище; непознатите capabilities и permissions са deny-by-default (`src/services/githubService.js:19-27`, `src/services/permissionService.js:97-107`, `src/tools/capabilityEngine.js:270-286`).
- Има CSP, HSTS, `nosniff`, frame protection и ограничена Permissions Policy (`server.js:46-80`). AI Markdown минава през DOMPurify, а при липсващ/грешащ sanitizer се използва `textContent` (`public/markdown-renderer.js:17-31`, `tests/markdownSecurity.test.js`).
- OAuth потоците използват `HttpOnly`, `Secure`, `SameSite=Lax` state/session cookies; MCP изисква PKCE S256, проверява `resource`, scopes и OpenAI/ChatGPT client metadata.
- Production workflow проверява точния commit пет последователни пъти, а след това сайт, readiness, реалната изолирана памет, MCP каталога/OAuth и tester auth (`.github/workflows/production-smoke.yml`).

## Констатации

### A-01 — MCP OAuth не е устойчив между инстанции и рестартирания

- **Критичност:** P1 висока.
- **Доказателство:** `codeInstanceSecret` се генерира с `randomBytes(32)` при стартиране на процеса; authorization code и refresh token се криптират с ключ, който включва тази стойност. Използваните authorization/refresh token IDs се пазят в два локални `Map` обекта (`src/services/mcpOAuthService.js:17-23`, `79-83`, `338-350`, `370-386`, `396-467`). Access token използва устойчивия `oauthSecret`, но code/refresh token не го правят самостоятелно. При одита две изолирани инстанции със същия конфигурационен secret върнаха `invalid_grant` както за code от A към B, така и за refresh token от A към B. Production rolling deployment реално върна смесено стария и новия commit преди да се стабилизира, което доказва, че заявките могат да попадат в различен процес/instance.
- **Реален проблем:** ChatGPT свързването може да отказва случайно при code exchange. След всеки restart/deploy 30-дневният refresh token става нечетим и приложението изисква ново свързване. Replay защитата не е обща между инстанциите, затова един token може да бъде приет веднъж във всяка инстанция.
- **Как се възпроизвежда:** зареди `mcpOAuthService.js` като два отделни module instances с еднакъв `MCP_ACCESS_TOKEN`; създай code/refresh token в A и го обмени в B. Получава се `invalid_grant`.
- **Предложение:** използвай отделен устойчив `MCP_OAUTH_ENCRYPTION_KEY`; пази authorization code/refresh rotation `jti` атомарно в общ устойчив store с TTL (например отделен OpenSearch индекс). Издаването/консумирането трябва да е еднократно в целия deployment, не в процеса.
- **Риск от поправката:** съществуващите refresh token-и ще трябва да се мигрират или потребителят да свърже ChatGPT отново веднъж.
- **Трудност:** средна.

### A-02 — Няма доказан backup/restore за общия OpenSearch state

- **Критичност:** P1 висока.
- **Доказателство:** в приложението няма snapshot repository, snapshot policy, restore процедура или автоматичен restore тест. `docs/TECHNICAL_AUDIT_2026-07-31.md` също отбелязва липсата, но не я доказва като отстранена. OpenSearch пази profile/conversation memory (`src/services/memoryService.js`), GitHub sessions (`src/services/githubOAuthService.js:221-255`), Google sessions (`src/services/googleDriveService.js:92-126`), confirmations (`src/services/confirmationService.js:46-89`), tester approvals (`src/services/testerAccessService.js:84-205`) и audit (`src/services/permissionService.js:117-159`).
- **Реален проблем:** повреда, погрешно изтриване или загуба на OpenSearch може едновременно да премахне лична памет, свързани външни профили, разрешения и проследимост. Readiness доказва текуща работа, не възстановимост.
- **Как се проверява:** създай snapshot на всички SYNCHRON-X индекси, възстанови го в отделен тестов cluster/index namespace, сравни броя/контролните суми и направи изолиран read/write/delete тест. Това не беше изпълнено, защото изисква реален инфраструктурен достъп и може да има цена.
- **Предложение:** инвентаризирай всички индекси, въведи автоматична snapshot policy, retention, криптиран отделен storage и периодичен restore drill в изолирана среда. Документирай RPO/RTO и процедура за връщане.
- **Риск от поправката:** неправилно зададен restore може да презапише production; нужен е отделен namespace и изрично разрешение за платен storage/операции.
- **Трудност:** голяма.

### A-03 — Политиката за потвърден запис в паметта се заобикаля

- **Критичност:** P1 висока.
- **Доказателство:** policy казва `memory.write: decision=confirm` (`src/services/permissionService.js:70-74`), а UI обещава точният текст да бъде показан преди постоянен запис (`public/app.js:1040-1042`). Въпреки това chat route автоматично записва high-confidence лични твърдения с `saveProfileMemory(..., "automatic-high-confidence")` без confirmation (`src/routes/chat.js:913-922`). `POST /memory/profile` също записва веднага след authentication, без Capability Engine/confirmation (`src/routes/memoryRouter.js:79-99`).
- **Реален проблем:** лична информация може да остане постоянно записана, въпреки че интерфейсът и permission моделът обещават човешки контрол. Това е несъответствие на privacy и product contract, не само UI дефект.
- **Как се възпроизвежда:** изпрати обикновено твърдение, разпознато от `extractImplicitMemoryCandidates`, например „Живея в …“, и после прочети profile memory; или извикай authenticated `POST /memory/profile` с валиден факт. Няма отделно confirmation ID.
- **Предложение:** избери един ясен договор: по подразбиране всички постоянни записи да се подготвят и потвърждават с durable one-time confirmation; автоматична памет да има само като изрично opt-in разрешение с видим журнал. Прекарай директния API през същата policy/capability граница.
- **Риск от поправката:** повече взаимодействия и по-малко автоматична персонализация; нужни са UX промени и миграционна комуникация.
- **Трудност:** средна.

### A-04 — Legacy memory-delete confirmation е само в RAM и не е свързано с owner

- **Критичност:** P2 средна.
- **Доказателство:** `pendingDeletes` е process-local `Map`, индексиран само по потребителски подадения `sessionId`; entry съдържа `fact`, `scope`, `expiresAt`, но не `ownerId` (`src/services/pendingDeleteService.js:1-44`). Chat route чете pending state само по `cleanSessionId`, а при потвърждение използва текущия `ownerId` (`src/routes/chat.js:796-830`).
- **Реален проблем:** restart/rolling deploy губи очакващо потвърждение. Двама различни профили с еднакъв session ID могат да си презапишат pending state; потвърждаващият може да изтрие от собствената си памет факт, подготвен от друг профил. Случайните UUID session IDs намаляват вероятността, но кодът не гарантира изолация.
- **Как се възпроизвежда:** запиши pending delete за session `S` като профил A; прочети/замени същия `S` като профил B или рестартирай процеса преди „Да“.
- **Предложение:** замени legacy Map с durable confirmation service; свържи записа с `ownerId`, session ID, точен memory key/ID, действие и TTL. Консумирай атомарно преди delete.
- **Риск от поправката:** стари непотвърдени действия ще изтекат и ще трябва да се поискат отново.
- **Трудност:** средна.

### A-05 — Само най-новите 200 факта участват в list/update/delete-by-fact

- **Критичност:** P2 средна.
- **Доказателство:** `MAX_MEMORIES = 200`; `fetchProfileHits` винаги връща до 200 записа (`src/services/memoryService.js:13`, `381-400`). Същият helper се използва от list, save/de-dup и delete-by-fact (`501-517`, `575-603`, `633-667`). Записът не налага лимит и няма pagination/search-after.
- **Реален проблем:** при повече от 200 факта по-старите остават в OpenSearch, но не се виждат в стандартния UI и може да не се намерят за update/delete-by-fact. Могат да останат скрити дубликати. Bulk clear ги премахва, но това не заменя индивидуалния контрол.
- **Как се възпроизвежда:** създай 201+ изолирани memory records за един owner и опитай да list/delete най-стария по fact.
- **Предложение:** добави cursor pagination; за exact delete/update използвай пряка ownerId + normalized key/query, без предварително ограничен набор. Добави тест над границата.
- **Риск от поправката:** по-скъпи заявки и нужда от стабилен sort/cursor договор.
- **Трудност:** средна.

### A-06 — Rate limiting е локално за процеса

- **Критичност:** P2 средна.
- **Доказателство:** `express-rate-limit` се създава без споделен `store`, следователно използва MemoryStore (`src/middleware/rateLimits.js:8-22`). Production има rolling/multi-instance поведение.
- **Реален проблем:** лимитите за OAuth, private API и платени AI заявки се умножават по броя инстанции и се нулират при restart. Това отслабва защита срещу разход и abuse.
- **Как се възпроизвежда:** изпрати заявки през различни instances или рестартирай процеса след достигане на лимита; counter-ът не е общ.
- **Предложение:** използвай споделен TTL store с atomic increment, отделни ключове по route/identity и ограничен fail-safe режим. За един потребител може да се използва малък съществуващ устойчив store без нова платена услуга, ако натоварването е ниско.
- **Риск от поправката:** недостъпен store може да блокира легитимни заявки; трябва изрична fail-open/fail-closed политика по route.
- **Трудност:** средна.

### A-07 — Част от външните OAuth/Google заявки нямат timeout

- **Критичност:** P2 средна.
- **Доказателство:** Google token exchange/refresh и общите Google API calls не подават `AbortSignal` (`src/services/googleDriveService.js:192-204`, `266-312`, `315-399`). GitHub OAuth code exchange и profile read също нямат timeout (`src/services/githubOAuthService.js:121-164`). За сравнение GitHub repository service, Supabase, Copilot и AI planner имат AbortController/timeout.
- **Реален проблем:** забил upstream може да държи Express request и ресурси неопределено дълго, да създаде натрупване и да изглежда като замръзнал сайт.
- **Как се възпроизвежда:** подай test `fetchImpl`, който никога не приключва; service promise остава pending.
- **Предложение:** общ bounded fetch helper с connect/request timeout, typed 504 error и ограничен retry само за безопасни idempotent заявки. Calendar POST не трябва да се retry-ва на сляпо без idempotency стратегия.
- **Риск от поправката:** прекалено кратък timeout може да отказва бавни, но валидни операции.
- **Трудност:** малка.

### A-08 — Одитният журнал може да се изгуби точно при инфраструктурен проблем

- **Критичност:** P2 средна.
- **Доказателство:** когато няма OpenSearch client, audit events се пазят само в RAM до 500 записа; при грешка от съществуващ OpenSearch client caller-ите често логват и продължават (`src/services/permissionService.js:117-159`, `src/routes/chat.js:92-99`, `src/routes/memoryRouter.js:21-26`). Audit е в същата система като данните и потвържденията.
- **Реален проблем:** рестарт губи fallback журнала, а OpenSearch инцидент може едновременно да скрие причината и действията около него. Успешно външно действие може да няма устойчив audit record.
- **Как се възпроизвежда:** изпълни action с `getOpenSearchClient() === null`, после рестартирай; fallback events изчезват.
- **Предложение:** локален append-only spool с ограничен размер и последващо изпращане или независим устойчив audit sink; risky write може да изисква успешно предварително audit събитие. Не записвай payload/secrets.
- **Риск от поправката:** дисковият spool и retry могат да дублират записи; нужни са event IDs и idempotency.
- **Трудност:** средна.

### A-09 — Проверка след deployment има, но автоматичен rollback и аларми не са доказани

- **Критичност:** P2 средна.
- **Доказателство:** `.github/workflows/production-smoke.yml` чака точния commit и публикува success/failure status, но няма rollback job или нотификация извън GitHub. DigitalOcean rollback настройките и alerts не са достъпни през наличните read-only доказателства.
- **Реален проблем:** лош commit ще бъде открит, но може да остане в production до ръчна намеса. Ако никой не гледа GitHub статуса, проблемът може да остане незабелязан.
- **Как се проверява:** безопасен staging drill с умишлено failing health и доказан rollback към предишния image/commit; проверка на реална alert доставка. Не беше изпълнено срещу production.
- **Предложение:** документиран one-click rollback към последния зелен commit; alert при failed/missing smoke; автоматичен rollback само след staging доказателство и защита срещу rollback loop.
- **Риск от поправката:** автоматичен rollback може да върне несъвместима data/schema промяна; засега няма миграции, но договорът трябва да го предвиди.
- **Трудност:** средна.

### A-10 — Dev dependency рисковете и статичният стил не се gate-ват в CI

- **Критичност:** P3 ниска.
- **Доказателство:** пълният `npm audit` отчита 23 high dev-only findings през `brace-expansion/minimatch`, ESLint и Jest dependency tree; production audit е чист. CI изпълнява само `npm test` и `npm audit --omit=dev`. В `package.json` има ESLint/Prettier, но няма `lint`/`format:check` scripts и те не се изпълняват в workflow.
- **Реален проблем:** уязвим dev tooling може да бъде атакуван от неповерени glob inputs/репо съдържание, а style/static regressions не блокират merge. Това не е production runtime exposure.
- **Как се възпроизвежда:** `npm audit`; провери `package.json` scripts и `.github/workflows/nodejs.yml`.
- **Предложение:** отделен клон за dependency upgrades, `npm audit` triage с фиксирани версии и CI `lint`/`format:check`. Не използвай сляпо breaking `npm audit fix --force`.
- **Риск от поправката:** upgrade на ESLint/Jest може да промени конфигурация/тестова семантика.
- **Трудност:** малка до средна.

### A-11 — Legacy/dead code увеличава security и operational объркването

- **Критичност:** P3 ниска.
- **Доказателство:** `services/logic-core` и `LOGIC_CORE_URL` не се извикват от текущото Node приложение; `start-dev.sh` още стартира Python service. `confirmedActionsRouter.js` и legacy `githubWriteService.js` съдържат direct write пътища с `GITHUB_TOKEN`, но router-ът не е монтиран в `server.js`, а allowed-action списъкът не допуска старите действия. `.env.example` правилно ги отбелязва като legacy, но кодът остава.
- **Реален проблем:** разработчик може погрешно да активира стар път, да конфигурира ненужен широк token или да поддържа две различни confirmation реализации.
- **Как се възпроизвежда:** `rg "confirmedActionsRouter|LOGIC_CORE_URL|GITHUB_TOKEN" server.js src services start-dev.sh`.
- **Предложение:** след отделна проверка премахни или архивирай немонтирания router/service; запази само OAuth/Copilot write потока. Не активирай Logic Core без конкретна продуктова нужда.
- **Риск от поправката:** може да се премахне неописан локален workflow; първо потвърди usage.
- **Трудност:** малка.

### A-12 — Няколко модула са прекалено големи и смесват отговорности

- **Критичност:** P3 ниска.
- **Доказателство:** `public/app.js` е 1620 реда, `src/routes/chat.js` 1449, `src/services/digitalOceanService.js` 945, `src/services/memoryService.js` 856 и `src/services/copilotTaskService.js` 844. `chat.js` едновременно управлява memory commands, image flow, planner, capabilities, confirmations, SSE и AI conversation.
- **Реален проблем:** промяна в една функция има голяма regression повърхност; security review и ownership са по-трудни.
- **Как се възпроизвежда:** `wc -l` на файловете и преглед на import/branch структурата.
- **Предложение:** постепенно извличай domain handlers зад съществуващи тестове, започвайки с memory action orchestration и confirmation dispatch. Без framework rewrite.
- **Риск от поправката:** механичен refactor може да промени реда на side effects/SSE; изисква characterization tests.
- **Трудност:** средна.

## Тестово покритие: какво доказва и какво не

### Доказва

- owner/tester identity изолация и protected routes;
- memory parsing, replacement, exact delete, error/retry paths и изолиран startup acceptance;
- OAuth cookie encryption, MCP PKCE/scopes/token rotation в една process instance;
- GitHub allowlist/Copilot task status и confirmation security;
- Google request shapes, включително Calendar event без attendees;
- Markdown sanitization, security headers, mobile UI и runtime status;
- production dependencies без известни high vulnerabilities;
- точния production commit и основните live readiness contracts.

### Не доказва

- MCP OAuth между различни instances/restart;
- restore от реален OpenSearch snapshot;
- memory поведение над 200 факта;
- owner-bound pending memory delete при еднакъв session ID;
- distributed rate limiting;
- timeout поведение на Google/GitHub OAuth fetch paths;
- истинско Google Calendar създаване с лично одобрен scope;
- истинска GitHub задача от owner browser session;
- rollback drill и alert доставка;
- натоварване, memory leak и дългосрочно съхранение.

## Какво не е могло да бъде проверено

| Област | Състояние | Нужен безопасен достъп/тест |
|---|---|---|
| OpenSearch snapshot/restore | **Не е проверено** | Read-only inventory и отделен restore namespace; изрично разрешение преди платен storage/restore операция. |
| DigitalOcean backups, firewall, volumes, разходи и rollback | **Не е проверено** | Owner-authenticated read-only account audit; без показване на token стойности. |
| Cloudflare DNS/WAF/TLS настройки | **Не е проверено** | Owner-authenticated read-only zone audit. |
| GitHub branch protection/ruleset на `main` | **Не е проверено** | Read-only ruleset/branch-protection API достъп. |
| Централизирани logs, metrics и alerts | **Не е проверено** | Read-only DigitalOcean/monitoring dashboard и тестова alert доставка. |
| Пълен secret scan на цялата Git история | **Не е проверено** | Одобрен history scanner; текущото дърво е проверено без открити стойности. |
| Реална Supabase регистрация/вход на нов tester | **Не е проверено в този одит** | Отделен тестов имейл и лична интеракция; не се създава профил автоматично. |
| Реален owner GitHub write от сайта | **Не е проверено** | Owner GitHub login в браузър и безопасна тестова задача. |
| Реален Google OAuth/Calendar write | **Не е проверено** | Лично одобрение на `calendar.events`, тестово събитие и после изрично потвърдено почистване. |
| ChatGPT custom MCP app end-to-end | **Не е проверено** | ChatGPT web Developer mode и личен login; не се въвеждат пароли/кодове от асистента. |
| Performance/load/cost ceiling | **Не е проверено** | Staging load test и актуални platform metrics/cost data. |

## Оправи сега

1. **A-01:** устойчив MCP OAuth key и общ atomic replay/rotation store.
2. **A-03:** единна policy граница за всеки постоянен memory write; автоматичен запис само след opt-in/confirmation.
3. **A-04:** owner-bound durable memory-delete confirmations.
4. **A-02:** планирай и докажи backup/restore, когато е разрешена инфраструктурната/платената операция.

## Оправи по-късно

1. **A-05:** pagination и exact queries над 200 факта.
2. **A-06:** distributed rate limiting за OAuth и paid AI.
3. **A-07:** bounded outbound timeouts и безопасни retry правила.
4. **A-08:** устойчив audit spool/sink.
5. **A-09:** rollback drill и alerts.
6. **A-10:** dev dependency и lint/format CI отделно от production.
7. **A-11/A-12:** премахване на доказано мъртъв код и постепенен refactor.

## Не е нужно сега

- пренаписване на приложението или смяна на Express/vanilla frontend;
- активиране/разширяване на Logic Core без конкретен липсващ capability;
- нова база данни само заради архитектурна чистота;
- microservices, Kubernetes или масово horizontal scaling преди реално натоварване;
- автоматично изпращане на Gmail, покани, плащания или други рискови write интеграции;
- токенизация, фондация или сложна организационна структура.

## Предложен безопасен ред

1. Поправи и тествай A-01 с две process instances и restart test.
2. Уеднакви memory write договора (A-03), без да променяш или мигрираш съществуващи лични факти автоматично.
3. Премести memory delete върху owner-bound durable confirmation (A-04).
4. Добави pagination/exact query тест над 200 записа (A-05).
5. Въведи outbound timeouts и distributed limiter (A-07, A-06).
6. Подсили audit и release alerts/rollback (A-08, A-09).
7. След отделно разрешение направи OpenSearch snapshot/restore drill (A-02).
8. Накрая почисти dev dependencies/dead code и раздели големите модули без промяна на поведението.

Докладът не прави поправките. Всяка следваща промяна трябва да бъде отделна малка задача, клон и Draft PR с независими тестове и production проверка според риска.
