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
- AI: OpenAI Responses API по подразбиране, с Gemini и Grok като допълнителни
  двигатели;
- изпълнение: Task Orchestrator → Capability Engine → Tool Registry;
- защитен кодов цикъл: трите AI двигателя дават предложения, OpenAI coding
  моделът ги синтезира, потребителят потвърждава точния diff, след което се
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
