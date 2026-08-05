# SYNCHRON-X operations runbook

Това е единният безопасен ред за проверка на production, triage на инцидент и
rollback. Историческите audit документи пазят контекст, но не са източник за
текущ commit, тестова бройка или runtime състояние.

## Източници на истина

| Проверка             | Източник                                       | Условие за успех                                               |
| -------------------- | ---------------------------------------------- | -------------------------------------------------------------- |
| GitHub `main`        | `git ls-remote origin refs/heads/main`         | връща един SHA                                                 |
| Production commit    | `GET https://synchron.foundation/health`       | `status=ok` и `commit` съвпада с `main`                        |
| Readiness            | `GET https://synchron.foundation/health/ready` | `status=ready`                                                 |
| Памет                | `checks.memory` и `checks.memoryAcceptance`    | green, ready, isolated, cleanup, без промяна на реалната памет |
| MCP                  | `checks.bridge` и `/mcp`                       | configured, responding и валиден каталог                       |
| Тестови профили      | `GET /api/auth/session`                        | четирите безопасни configuration флага са `true`               |
| Deploy доказателство | commit status `synchron/production-smoke`      | `success` за същия SHA                                         |

Не обявявай deployment за успешен само защото `/health` отговаря. Exact SHA,
readiness и production smoke трябва да сочат една и съща версия.

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
curl --fail --silent --show-error https://synchron.foundation/api/auth/session
```

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
3. memory acceptance е ready, isolated, cleanup completed и real memory
   unchanged;
4. MCP каталогът и OAuth challenge са валидни;
5. tester auth readiness е зелено;
6. `synchron/production-smoke` е success;
7. причината и приложената поправка са записани без secrets или лични данни.
