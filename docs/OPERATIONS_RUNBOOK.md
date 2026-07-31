# SYNCHRON-X Operations Runbook

Този runbook е за безопасна диагностика на production и възстановяване чрез
GitHub. Командите в секцията „Read-only проверка“ не променят код, настройки,
тайни или потребителски данни.

## Източници на истина

- GitHub `main`: версията, която трябва да бъде публикувана;
- `GET /health`: реалният production commit и liveness;
- `GET /health/ready`: AI, OpenSearch, изолираният memory acceptance и MCP;
- `GET /health/bridge`: публична MCP диагностика без лични данни;
- `GET /api/auth/session`: готовност на tester auth без разкриване на secrets;
- GitHub Actions: `Node.js checks` и `Production smoke check` за точния commit.

Не копирай commit или брой тестове в инструкции като „текуща истина“. Те се
променят при всеки merge.

## Read-only проверка

Задай repository и production адреса локално:

```bash
repo="radostinvgeorgiev-commits/sunchron-backend"
base="https://synchron.foundation"
```

### 1. Exact commit и liveness

```bash
git fetch origin main
expected="$(git rev-parse origin/main)"
actual="$(curl --fail --silent --show-error "$base/health" | jq -r '.commit')"
test "$actual" = "$expected"
curl --fail --silent --show-error "$base/health" | jq '{status,service,version,commit}'
```

Успех: `status` е `ok` и `actual` съвпада с пълния SHA на `origin/main`.
Провери поне два пъти през кратък интервал при току-що завършил deployment.

### 2. Readiness и изолирана памет

```bash
curl --fail --silent --show-error "$base/health/ready" | jq '{
  status,
  commit,
  chat: .checks.chatAgent,
  memory: .checks.memory,
  memoryAcceptance: .checks.memoryAcceptance,
  bridge: .checks.bridge
}'
```

Успех:

- общият `status` е `ready` и commit-ът е точният очакван SHA;
- `chatAgent.ready` и `memory.ready` са `true`;
- `memoryAcceptance` е `required: true`, `ready: true`, `status: "works"`;
- `isolated`, `realMemoryUnchanged` и `cleanupCompleted` са `true`;
- `passedSteps` е очакваният брой от текущата версия на acceptance теста;
- `bridge.configured` и `bridge.responding` са `true`.

Memory acceptance използва временен изолиран owner. Не го заменяй с ръчна
операция върху личната памет.

### 3. MCP каталог и OAuth challenge

Публичната bridge диагностика не извиква личен инструмент:

```bash
curl --fail --silent --show-error "$base/health/bridge" | jq
curl --fail --silent --show-error \
  "$base/.well-known/oauth-protected-resource" | jq
curl --fail --silent --show-error \
  "$base/.well-known/oauth-authorization-server" | jq
```

Провери каталога без bearer token. `tools/list` е публично описание, но
`tools/call` към защитен инструмент трябва да върне OAuth challenge, а не данни:

```bash
curl --fail --silent --show-error \
  --header 'Content-Type: application/json' \
  --header 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  "$base/mcp" | jq '.result.tools | map({name,annotations,securitySchemes})'

curl --fail --silent --show-error \
  --header 'Content-Type: application/json' \
  --header 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_project_context","arguments":{}}}' \
  "$base/mcp" | jq '{isError:.result.isError,challenge:.result._meta["mcp/www_authenticate"]}'
```

Успех: каталогът няма дублирани имена; защитеното извикване е `isError: true`
и съдържа `Bearer` challenge с необходимия scope. Не добавяй production token
към shell history, CI output или incident report.

### 4. Tester auth readiness

```bash
curl --fail --silent --show-error "$base/api/auth/session" | jq '{
  configured,
  registrationEnabled,
  projectConnection: .configuration.projectConnection,
  sessionProtection: .configuration.sessionProtection
}'
```

Това доказва конфигурационна готовност, не успешен owner/tester вход. Реален
вход се проверява само в отделна защитена браузърна сесия без споделяне на
парола, cookie, invite code или token.

### 5. GitHub проверки

За merge commit-а отвори GitHub Actions и провери:

- `Node.js checks` е `success`;
- `Production smoke check` е `success` за същия пълен SHA;
- commit status `synchron/production-smoke` е успешен.

Workflow файлът `.github/workflows/production-smoke.yml` е изпълнимата
спецификация за exact commit, публичен сайт, readiness, memory acceptance, MCP
каталог/OAuth challenge и tester auth readiness.

## Incident triage

1. Запиши UTC час, очакван commit и действителен commit — без secrets и лични
   данни.
2. Определи най-тясната повредена граница: deploy, liveness, readiness, AI,
   памет, MCP, tester auth или външна услуга.
3. Сравни production SHA с `origin/main`. Стар SHA може да означава незавършил
   deployment, а не дефект в новия код.
4. Прегледай GitHub Actions и безопасните DigitalOcean metadata/log summaries.
   Не публикувай environment стойности или authorization headers.
5. Възпроизведи локално само с тестови/измислени данни и пусни `npm test` и
   production dependency audit.
6. Ако impact-ът е ограничен, направи отделен fix PR. Ако production е
   неизползваем и последният merge е доказаната причина, използвай rollback-а
   по-долу.

Не обявявай incident за приключен само защото deployment е стартирал. Изисквай
точния production SHA, зелен readiness и успешен production smoke.

## Безопасен rollback чрез revert PR

Rollback е кодова промяна и изисква точен target и преглед. Не използвай direct
push към `main`, `git reset --hard`, force push или ръчна промяна на production
connection.

1. Потвърди кой merge commit е причинил проблема и кои последващи commits биха
   били засегнати.
2. Създай отделен branch от актуалния `origin/main`.
3. Изпълни `git revert <точен-merge-sha>`; при merge commit използвай правилния
   mainline parent само след преглед на родителите.
4. Пусни пълните тестове и `npm audit --omit=dev --audit-level=high`.
5. Отвори отделен revert PR с доказателство, impact, риск и план за проверка.
6. След преглед слей PR-а по нормалния защитен процес.
7. Изчакай production да покаже точния revert merge SHA и изисквай успешни
   `Node.js checks` и `Production smoke check`.
8. Документирай причината и отвори отделна задача за трайната поправка.

При конфликт или неясен target спри. Не решавай инцидента чрез изтриване на
история или заобикаляне на branch protection.

## Действия, които изискват изрично потвърждение

Следните действия не са read-only диагностика и не се изпълняват по този
runbook без конкретно разрешение и rollback/cleanup план:

- създаване на OpenSearch restore/fork или друг платен ресурс;
- промяна на production connection, app spec или DNS;
- добавяне, смяна или ротация на secrets и tokens;
- изтриване или промяна на реални данни/памет;
- изпращане на външни съобщения или GitHub write от името на потребителя;
- force push, директен push към `main` или заобикаляне на проверки.

Ако липсва owner достъп, показвай „не е проверено“, а не „работи“ или „няма
данни“.

## Локална проверка на промяна

```bash
npm ci
npm test
npm audit --omit=dev --audit-level=high
```

Dev-only audit предупреждения се оценяват отделно. Не използвай breaking
`npm audit fix --force` върху lint/test toolchain без отделна миграция и тестове.
