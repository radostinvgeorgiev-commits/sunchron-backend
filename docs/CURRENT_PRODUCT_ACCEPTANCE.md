# Текущ production acceptance

## Прието

- Canonical site: `https://cloudaicore.com`.
- Production backend се управлява от `main` и трябва да се доказва с exact SHA
  преди deployment решение.
- Cloud Run е текущият production runtime.
- Firestore е текущият runtime backend за памет и operational state.
- Identity Platform е текущият auth backend.
- Claude Haiku 5.5 е разговорният двигател по подразбиране; OpenAI, Gemini и
  Grok са допълнителни двигатели при валидна конфигурация. Изборът на модел в
  чата приема само икономичните модели.
- Claude участва само при конфигуриран `ANTHROPIC_API_KEY`. Claude е и
  кодовият агент (анализ и branch/PR); Codex вече не се използва и нищо не
  прави direct push към `main`.
- Production defaults са Firestore + Identity Platform; legacy OpenSearch и
  Supabase се включват само при изрична конфигурация.
- Task Orchestrator може да планира multi-step задачи.
- Инструменталните задачи имат owner-scoped durable run с checkpoint-и и
  pause/resume/cancel API.
- Сайтът има Council режим, който пита избраните налични AI двигатели, показва
  наличните отговори при частичен отказ и отделна структурирана препоръка преди
  изпълнение.
- Claude е водещ кодов изпълнител в branch/PR поток под owner confirmation;
  OpenAI, Gemini и Grok дават предложения и са резерва.
- AI CORE Code Write подготвя ограничен multi-engine plan и след точно
  потвърждение създава отделен branch, commit и Pull Request.
- MCP има OAuth boundary и актуален каталог.
- GitHub, Google Workspace, web search, memory и задачи минават през Capability
  Engine и audit.

## Все още не е доказано като готово

1. Production exact-SHA проверка от `/health` не е приложена към този документ.
2. `/health/ready` и `/health/storage-report` трябва да се проверят преди release.
3. Firestore backup/restore остава `unverified`, докато няма отделен restore тест.
4. Production audit read за A4 остава незавършен, докато `list_action_history`
   или еквивалентен read-only adapter не върне проверим резултат.
5. A5 остава незавършен, докато няма реален staging fault-injection/recovery
   тест, а не само локален тест.
6. Browser acceptance след PR промени трябва да се изпълни преди merge/deploy.
7. Claude и кодовият агент не се приемат за работещи само защото са показани в UI;
   трябва да имат конфигурация, capability gate, audit и краен тест.

## Задължителни проверки преди deployment

1. `/health` връща `ok` и exact SHA, който съвпада с release commit.
2. `/health/ready` е `ready`.
3. `/health/storage-report` показва healthy Firestore и Identity Platform.
4. `npm test` минава на release branch.
5. `git diff --check` няма whitespace грешки.
6. `synchron/production-smoke` е зелен за release commit.
7. Реална owner сесия изпълнява един read и един потвърден write acceptance.
8. Реален нов потребител минава публична регистрация, потвърждава имейла си и
   влиза; профил със запис за достъп, различен от `approved` (например
   `revoked`), остава блокиран. Health проверките не доказват сами реална
   регистрация.
9. Няма merge/deploy без owner review и отделно потвърждение.

## Следващо

1. Преглед и merge решение за PR #379 или пренасяне на нужната поправка в новия
   release branch.
2. Реален browser acceptance на Council → избор → разрешено действие.
3. Production audit read acceptance за A4.
4. Staging fault-injection/recovery acceptance за A5.
5. Exact-SHA deployment и визуална проверка на сайта след merge.

Продуктовата посока е в `PRODUCT_DIRECTION.md`; оперативните стъпки са в
`OPERATIONS_RUNBOOK.md`; MVP статусът е в `MVP_ACCEPTANCE_CHECKLIST_2026-08.md`.
