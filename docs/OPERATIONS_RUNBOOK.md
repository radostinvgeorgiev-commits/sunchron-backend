# AI CORE operations runbook

Това е единният безопасен ред за проверка на production, triage на инцидент и
rollback. Историческите audit документи пазят контекст, но не са източник за
текущ commit, тестова бройка или runtime състояние.
Актуалното продуктово състояние и следващите acceptance стъпки са в
[`CURRENT_PRODUCT_ACCEPTANCE.md`](./CURRENT_PRODUCT_ACCEPTANCE.md).

## Източници на истина

| Проверка             | Източник                                       | Условие за успех                                               |
| -------------------- | ---------------------------------------------- | -------------------------------------------------------------- |
| GitHub `main`        | `git ls-remote origin refs/heads/main`         | връща един SHA                                                 |
| Production commit    | `GET https://synchron.foundation/health`       | `status=ok` и `commit` съвпада с `main`                        |
| Readiness            | `GET https://synchron.foundation/health/ready` | `status=ready`                                                 |
| Storage зависимости  | `GET /health/dependencies`                     | OpenSearch и Supabase са `healthy`                             |
| Backup наблюдение    | `GET /health/backups`                          | OpenSearch е `verified`; Supabase е честно означен             |
| Памет                | `checks.memory` и `checks.memoryAcceptance`    | green, ready, isolated, cleanup, без промяна на реалната памет |
| MCP                  | `checks.bridge` и `/mcp`                       | configured, responding и валиден каталог                       |
| Auth конфигурация    | `GET /api/auth/session`                        | четирите безопасни configuration флага са `true`               |
| Deploy доказателство | commit status `synchron/production-smoke`      | `success` за същия SHA                                         |

Не обявявай deployment за успешен само защото `/health` отговаря. Exact SHA,
readiness и production smoke трябва да сочат една и съща версия.

## Google Cloud migration boundary

Частният Cloud Run staging и Firestore са отделени от текущия DigitalOcean
production канал. Конфигурационният каталог и migration gates са в
[`GOOGLE_CLOUD_CONFIGURATION_CATALOG.md`](./GOOGLE_CLOUD_CONFIGURATION_CATALOG.md).
Докато всички gates не са приети, не прави production import, DNS cutover или
изключване на DigitalOcean, OpenSearch, Supabase или Cloudflare.

Firestore memory/persistence и Identity Platform auth са отделни code-level
кандидати. Identity acceptance изисква signup, email verification, logout,
повторен login, Firestore tester approval и различен memory owner за два
профила. Наличен Secret Manager reference или зелен unit test не е user import.

Cloud Run използва `/health` само за startup/liveness. `/health/ready` остава
deployment acceptance проверка, защото включва AI, избрания memory backend, memory acceptance
и bridge. Не използвай readiness endpoint като liveness probe и не приемай
подготвен YAML или image като deployed/accepted.

Флаговете `configured`, `registrationEnabled`, `projectConnection` и
`sessionProtection` доказват само runtime конфигурация. Те не доказват, че нов
потребител реално може да се регистрира, да излезе и да влезе отново. Това се
приема само с отделен изолиран signup/logout/login тест.

## Owner acceptance

След зелен production baseline изпълнявай реалните ChatGPT MCP, GitHub и Google
проверки само по [`OWNER_ACCEPTANCE_RUNBOOK.md`](./OWNER_ACCEPTANCE_RUNBOOK.md).
Този цикъл започва read-only; всяко външно write действие има отделно точно
потвърждение, проверка на резултата и cleanup.

## Read-only проверка

Изпълни от чисто копие на хранилището:

```bash
git fetch origin main
git status --short --branch
git rev-parse origin/main
npm ci
npm test
npm audit --omit=dev --audit-level=high
```

DigitalOcean App Platform е единственият production deployment канал за сайта.
Не добавяй GitHub Pages deployment или отделен tunnel worker без доказана нужда,
точна цена, runtime конфигурация и изрично разрешение. Cloudflare обслужва DNS и
edge proxy към DigitalOcean; наличието на Cloudflare не означава, че е нужен
`cloudflared` Tunnel.

После провери публичните endpoints, без credentials:

```bash
curl --fail --silent --show-error https://synchron.foundation/health
curl --fail --silent --show-error https://synchron.foundation/health/ready
curl --fail --silent --show-error https://synchron.foundation/health/dependencies
curl --silent --show-error https://synchron.foundation/health/backups
curl --fail --silent --show-error https://synchron.foundation/health/storage-report
curl --fail --silent --show-error https://synchron.foundation/api/auth/session
```

`/health/dependencies` е жива read-only проверка на OpenSearch и Supabase и
връща `503`, ако някоя от тях е недостъпна. `/health/backups` показва само
безопасен статус и връща `503`, докато покритието е частично.
`opensearch.status=verified` и `fresh=true` доказват свеж backup inventory за
точния production cluster, но `provesRestore=false` означава, че възстановяване
не е изпълнявано. Supabase backup статусът остава `unverified`, докато не бъде
проверен чрез разрешен owner/management изглед.

`/health/storage-report` връща същите два безопасни отчета в JSON с транспортен
HTTP `200`, за да не бъдат скривани точните вътрешни статуси от edge 5xx
страница. Той не променя health семантиката: production smoke оценява
`dependencies.status` и `backups.status`, а не общия HTTP код на отчета.

MCP каталогът е read-only JSON-RPC заявка:

```bash
curl --fail --silent --show-error \
  --header 'Content-Type: application/json' \
  --header 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  https://synchron.foundation/mcp
```

Сравни имената, броя и `securitySchemes` с очакванията в
`.github/workflows/production-smoke.yml`. Не извиквай инструмент, който пише,
и не добавяй bearer token към диагностичните команди.

GitHub commit status се проверява за exact production SHA:

```text
GET /repos/radostinvgeorgiev-commits/sunchron-backend/commits/<sha>/status
context: synchron/production-smoke
state: success
```

Използвай свързаното GitHub приложение или публичния GitHub API. Не създавай
нов token само за тази проверка.

## Incident triage

1. Запиши само timestamp, очаквания SHA, наблюдавания SHA, endpoint/status code
   и GitHub run URL. Не копирай response данни, които могат да съдържат лична
   информация.
2. Определи границата:
   - deploy mismatch — production още не е на `main`;
   - readiness failure — приложение, памет или bridge не е готов;
   - MCP failure — каталогът, OAuth challenge или обработчикът не отговаря;
   - identity failure — tester/owner конфигурацията не е готова;
   - storage dependency failure — OpenSearch или Supabase не отговаря на
     ограничената жива проверка;
   - backup visibility failure — backup inventory не може да бъде потвърден;
   - dependency/CI failure — release-ът не трябва да се merge-ва.
3. Провери последния зелен exact commit и първия неуспешен commit. Не приемай,
   че най-новият merge е причината без diff и лог доказателство.
4. Ако production още обслужва предишния зелен commit, изчакай текущия
   deployment в рамките на workflow timeout-а. Не стартирай втори deploy върху
   активен deploy.
5. Ако текущият exact commit е активен и readiness/smoke е червен, спри новите
   merge-ове и избери минимална поправка или rollback.

## Rollback на приложен код

Rollback се прави чрез отделен revert PR, не с direct push, force push или
промяна на production secret:

```bash
git fetch origin main
git switch --create revert/<кратка-причина> origin/main
git show --no-patch --pretty=%P <лошия-commit>
npm test
npm audit --omit=dev --audit-level=high
```

Ако дефектният commit има един parent, използвай `git revert <commit>`. Ако е
merge commit, първо потвърди, че първият parent е предишният `main`, и използвай
`git revert -m 1 <merge-commit>`. Не гадай mainline parent-а.

Преди merge провери, че revert-ът премахва само дефектната промяна и не връща
по-нови независими защити. След merge изчакай exact SHA и повтори целия
production smoke. Ако revert-ът засяга данни, identity, secrets или външен
write adapter, спри и поискай изрично разрешение.

## Памет и OpenSearch

При memory инцидент:

- не изтривай индекси или документи;
- не сменяй production connection към друг cluster;
- не стартирай restore/fork;
- не използвай личната памет за диагностичен тест;
- използвай само изолирания acceptance owner и съществуващия read-only backup
  inventory.

Истински restore/fork може да създаде платен ресурс. Преди него са задължителни
точна цена, cost ceiling, изрично разрешение, изолиран target и план за
изтриване след теста.

Потвърдените 3 OpenSearch restore точки не са restore тест. Не пренасочвай
production към тях и не стартирай временен cluster без отделното разрешение.
Supabase backup policy също остава непроверена, докато runtime разполага само с
publishable key.

При Free Plan има две отделни решения, нито едно не се включва автоматично:
платен plan със scheduled backups или криптиран логически `supabase db dump` в
одобрено външно хранилище. Логическият dump изисква нов привилегирован DB secret,
retention, контрол на достъпа, наблюдение и изолиран restore тест.

## Secrets и OAuth

- Не показвай стойност, дължина, hash или fragment на secret/token.
- Не сменяй две свързани тайни едновременно.
- Добавяне, премахване или ротация на production secret изисква изрично
  разрешение и rollback план.
- При MCP OAuth миграция запази `MCP_ACCESS_TOKEN`, докато dedicated flow и
  refresh периодът не са доказани. Следвай `BRIDGE_AND_DIAGNOSTICS.md`.

## Режим без Copilot

Production работи безопасно с `COPILOT_AUTOMATION_ENABLED=false`. В този режим
GitHub Read остава активен, а `code.write`, `code.branch` и
`code.pull-request` спират преди потвърждение, OAuth или външно Copilot
извикване. `/health/integrations` трябва да връща за `github-write`:

- `enabled=false`;
- `executable=false`;
- `healthStatus=unavailable`;
- `availabilityCode=COPILOT_AUTOMATION_DISABLED`.

Не променяй настройката само защото GitHub OAuth работи. Стойност `true` се
добавя едва след потвърдени Copilot кредити и отделно разрешение за production
конфигурацията; защитите за собственическа сесия и точно потвърждение остават
задължителни.

## Кога инцидентът е затворен

Инцидентът е приключил само когато:

1. `main`, `/health` и провереният commit status сочат един SHA;
2. `/health/ready` е ready;
3. `/health/dependencies` е healthy и `/health/backups` връща очаквания
   безопасен статус;
4. memory acceptance е ready, isolated, cleanup completed и real memory
   unchanged;
5. MCP каталогът и OAuth challenge са валидни;
6. auth конфигурацията е зелена; реалният signup/login се отчита отделно;
7. `synchron/production-smoke` е success;
8. причината и приложената поправка са записани без secrets или лични данни.
