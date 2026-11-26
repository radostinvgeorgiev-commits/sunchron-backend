# AGENTS.md — AI CORE

## Проект

AI CORE е лична AI операционна система с постоянна контролирана памет и
разрешени инструменти за реални задачи. Аватарът е нейният видим интерфейс, а
не отделен продукт.

## Текуща production архитектура

- repository: `radostinvgeorgiev-commits/sunchron-backend`, branch `main`;
- canonical site: `https://cloudaicore.com`;
- runtime: Google Cloud Run;
- памет, сесии, потвърждения и audit: Firestore;
- потребители: Google Identity Platform;
- тайни: Google Secret Manager и runtime service identity;
- AI: Claude Haiku 5.5 по подразбиране, с OpenAI, Gemini и Grok като
  допълнителни двигатели; изборът на модел, Съветът, сляпото сравнение,
  асистентите, гласът и споделянето са в `public/ui-refresh.js`,
  `public/prompt-tools.js`, `public/compare.js`, `public/share.js`;
- автоматични проверки: `synchron/production-smoke`, робот с браузър
  (`tests/ui/robot.mjs`, workflow „UI robot“), MCP `run_ai_core_self_test` и
  публична страница `/status`;
- изпълнение: Task Orchestrator → Capability Engine → Tool Registry;
- защитен кодов цикъл: Claude води кодовите задачи; OpenAI, Gemini и Grok
  дават предложения и са резерва, когато са конфигурирани. Codex вече не се
  използва. Потребителят потвърждава точния diff, след което се
  създават отделен branch, commit и Pull Request;
- MCP: `https://cloudaicore.com/mcp` с OAuth и owner-only write scopes.

Не фиксирай SHA или брой тестове в този файл. Преди промяна проверявай
актуалния `main`, работното дърво, `/health`, `/health/ready` и
`synchron/production-smoke`.

## Задължителни принципи

1. Не обявявай интеграция за работеща само защото е показана в UI.
2. Всеки инструмент има реален адаптер, конфигурационна проверка и краен тест.
3. Опасните действия изискват точен, еднократен и обвързан със сесията consent.
4. Кодът не се записва директно в `main`; използват се branch, commit, PR и CI.
5. Никога не показвай или записвай ключове, пароли, token-и или сурови OAuth
   сесии.
6. Пази owner isolation за памет, задачи, workspace и OAuth данни.
7. Пиши на български, кратко и конкретно.
8. Основно правило на собственика („котва“): агентът работи автономно и води.
   Знае целта, сам казва коя е следващата стъпка, сам проверява и сам върши
   работата. Не кара собственика да проверява или да прави нещо. Собственикът
   дава насоките и одобрява. Когато нещо спира агента, той казва точно какво го
   спира и какъв вариант (право или промяна в кода) ще му позволи да го направи
   сам след одобрение. Остават за собственика само: одобрение за пускане, вход
   с неговите профили и въвеждане на тайни ключове.

## Проверка и публикуване

- Работи в отделен `codex/` branch.
- Пускай `npm test` и `git diff --check`.
- Използвай свързаното GitHub приложение за PR и merge.
- След merge изчакай exact-SHA production smoke и провери реалното поведение в
  браузър.
- Не стартирай нови платени ресурси, не променяй IAM/secrets и не прави
  необратими действия без изрично разрешение.

Текущите acceptance критерии са в
`docs/CURRENT_PRODUCT_ACCEPTANCE.md`, а оперативните стъпки са в
`docs/OPERATIONS_RUNBOOK.md`. Историческите одити не са roadmap.
