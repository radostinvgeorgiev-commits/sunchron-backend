# Project state

## Overview
AI CORE / SYNCHRON-X работи на Cloud Run, използва Identity Platform за
профили и Firestore за данни и одобрения. Каноничен сайт: https://cloudaicore.com.

## What works
Кодът съдържа вход, регистрация с проверка на имейл и изолирани member профили,
както и MCP OAuth с PKCE. Наличието им в кода не доказва production работа.
Предвидени са възстановяване на прекъсната регистрация и еднократни потвърждения.

## What is broken
Production причината за неуспешната регистрация не е потвърдена: от средата
за разработка сайтът не се разрешава по DNS и настройките на Google Cloud не
са проверени. Кодът досега заменяше Identity Platform грешките с общи съобщения
и скриваше грешка при обновяване на име. След промяната се връщат безопасни
кодове и се записват структурирани диагностични събития. Интеграционният тест
използва симулирани Identity Platform и Firestore, не реален облачен профил.

## Claude/AI CORE connection
MCP URL: https://cloudaicore.com/mcp. OAuth е authorization code с PKCE S256.
Клиентът `synchron-claude` преди допускаше само `synchron:read` и
`offline_access`; останалите искани права водеха до `invalid_scope`. Промяната
разрешава изрично ограничени права само за owner и ограничава инструментите
допълнително по име. Директно MCP потвърждение от Claude е забранено.
Собственикът преглежда и потвърждава подготвеното на `/claude-confirm.html`.
Реалното поведение на Claude и production настройките още не са проверени.
Автоматичен branch/commit/draft PR без потвърждение и пълно управление на
сайта и Cloud Run не са реализирани. Cloud Logging диагностиката показва
наличие на скорошна грешка, а не съдържанието на произволни логове.

В кода Claude е основният двигател за разговор, Council решение и кодов план.
OpenAI, Gemini и Grok остават незадължителни съветници; Codex е изключен,
а старите workspace идентичности и настройки се запазват. Няма автоматичен
fallback при липсващ или недостъпен Claude. Конфигурационни имена:
`AI_CORE_PROVIDER`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`,
`ANTHROPIC_TIMEOUT_MS`. Свързването на Claude.ai към MCP OAuth е отделно от
Anthropic API за двигателя. Действителната production конфигурация и
достъпността на Anthropic API не са проверени. Claude може да подготвя
ограничен GitHub кодов план; записът изисква отделно потвърждение и създава
branch/commit/PR. Кодови задачи използват Claude самостоятелно по подразбиране;
други модели се викат само ако изрично са избрани. Чатът не стартира произволни
shell команди, не изпълнява локално пълните тестове и не merge/deploy-ва.
За Cloud Run Anthropic secret достъпът трябва да е даден на staging runtime
service account само върху конкретния staging secret, не на Claude.ai клиента
и не с project-wide Owner/Secret Manager права.

## Decisions
- 2026-11-23: Owner поиска разговор с AI CORE и подготовка на код; разговорът
  не изпълнява инструменти и не потвърждава действия.
- 2026-11-23: Owner разреши подготовка на deployment с отделно свое
  потвърждение, но предпочете ограничен достъп без права към secrets пред
  пълен Cloud Run достъп. Deployment не е разрешен през Claude: произволен
  deployment може да изложи runtime тайни, дори без Secret Manager scope.
- 2026-11-23: Owner разреши branch, commit и draft PR без отделно
  потвърждение; текущата реализация все още изисква потвърждение и за тях.
- 2026-11-23: Няма browser Firebase SDK; ключът на сървъра не трябва да се
  настройва като browser-only HTTP-referrer ключ.
- 2026-11-23: Owner избра Claude за основен двигател без автоматичен fallback;
  другите доставчици остават съветници, а Codex е деактивиран с legacy съвместимост.
- 2026-11-24: Кодовите задачи не викат платени съветници по подразбиране;
  избягва се допълнителен доставчик/API разход, освен при изричен избор.
- 2026-11-24: Staging се проверява преди production. Не се стартира deployment,
  докато няма потвърден staging проект/услуга и оторизиран deployment път.

## Next step
Потвърждаване на staging конфигурацията и оторизиран Cloud Shell/deployment
път, secret-level `roles/secretmanager.secretAccessor` за Anthropic staging
secret, след което еднократен Claude acceptance тест. Production deployment
изисква отделно owner решение и проверен Cloud Build trigger.
