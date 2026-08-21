# SYNCHRON-X AI CORE — архитектура

## Основен поток

Потребител → AI аватар → Task Orchestrator → Capability Engine → Tool Registry
→ изпълним адаптер → проверен резултат.

OpenAI Responses API е доставчикът по подразбиране. Gemini и Grok от xAI са
допълнителни двигатели за независими предложения. При включен Council режим
трите двигателя отговарят независимо, а отделен OpenAI арбитър връща
структурирана препоръка. Coding ролята се изпълнява от OpenAI модел с
ограничен структурен изход.

## Данни и runtime

- Cloud Run изпълнява единственото production приложение.
- Firestore пази паметта, разговорите, задачите, workspace, OAuth сесиите,
  durable task runs, еднократните потвърждения и audit събитията.
- Identity Platform управлява входа и тестовите профили.
- Secret Manager предоставя тайните само на runtime service identity.
- `https://cloudaicore.com/mcp` е единственият публичен MCP resource.

## Кодов Task Orchestrator

1. Проверява owner профила, GitHub OAuth и трите AI връзки.
2. Иска независими предложения от OpenAI, Gemini и Grok.
3. OpenAI coding ролята сравнява предложенията и връща най-много четири
   цели файла с пълно съдържание.
4. Показва плана и точната фраза за потвърждение.
5. След потвърждение създава branch, commit и Pull Request спрямо `main`.
6. CI проверява промяната; merge и production acceptance са отделни стъпки.

Забранени са директен запис в `main`, промени по secrets, deployment workflows
и пътища извън repository.

## Durable run protocol

Инструменталното изпълнение първо създава owner-scoped run със списък от стъпки.
Всеки преход се записва като checkpoint. `paused`, `waiting_confirmation`,
`partial` и `failed` не губят плана; `resume` продължава същия run след последния
checkpoint. При недостъпен Firestore чатът не се прекъсва, но честно показва,
че устойчивото проследяване не е налично.
