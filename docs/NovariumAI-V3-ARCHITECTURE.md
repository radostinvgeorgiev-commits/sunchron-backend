# NovariumAI — архитектура

## Основен поток

Потребител → AI аватар → Task Orchestrator → Capability Engine → Tool Registry
→ изпълним адаптер → проверен резултат.

Gemini е доставчикът по подразбиране за основните AI пътища. OpenAI остава
резервен доставчик за съществуващите функции, а Claude и Grok се използват там,
където са конфигурирани за специализирана работа. При Council режим избраните
двигатели отговарят независимо, Gemini синтезира препоръката, а OpenAI и Claude
остават резервни арбитри. Кодова задача събира предложения от конфигурираните
двигатели; Gemini води плана, а останалите остават резерви.

Този Gemini-first вариант е целта на Draft PR 0, не опис на вече променен
production runtime. До merge/deploy production стойностите остават тези в
`CURRENT_PRODUCT_ACCEPTANCE.md`.

## Данни и runtime

- Cloud Run изпълнява единственото production приложение.
- Firestore пази паметта, разговорите, задачите, workspace, OAuth сесиите,
  durable task runs, еднократните потвърждения и audit събитията.
- Identity Platform управлява входа и тестовите профили.
- Secret Manager предоставя тайните само на runtime service identity.
- `https://novariumai.com/mcp` е публичният MCP resource.

## Кодов Task Orchestrator

1. Проверява owner профила, GitHub OAuth и наличните AI връзки.
2. Иска независими предложения от конфигурираните двигатели.
3. Изпълнителят по ред Gemini, Claude, OpenAI, Grok сравнява предложенията и
   връща най-много четири цели файла с пълно съдържание.
4. Показва плана и точната фраза за потвърждение.
5. След потвърждение създава branch, commit и Pull Request спрямо `main`.
6. CI проверява промяната; аватарът може да подготви owner-confirmed merge към
   `main` само за точния head SHA и зелени проверки; production acceptance остава
   отделна стъпка.

Забранени са директен запис в `main`, промени по secrets, deployment workflows
и пътища извън repository.

## Durable run protocol

Инструменталното изпълнение първо създава owner-scoped run със списък от стъпки.
Всеки преход се записва като checkpoint. `paused`, `waiting_confirmation`,
`partial` и `failed` не губят плана; `resume` продължава същия run след последния
checkpoint. При недостъпен Firestore чатът не се прекъсва, но честно показва,
че устойчивото проследяване не е налично.

Council изборът пази отделен еднократен owner-scoped intent за 30 минути. Само
същият профил и същата сесия могат да го консумират; повторно консумиране,
чужда сесия или изтекъл intent се блокират преди Planner-а.
