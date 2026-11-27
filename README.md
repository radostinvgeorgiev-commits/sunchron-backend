# Novarium

Лична AI операционна система, достъпна на
[cloudaicore.com](https://cloudaicore.com). Novarium разговаря, пази изолирана
памет и изпълнява само разрешени инструменти.

## Архитектура

- Node.js 22 + Express;
- Google Cloud Run production runtime;
- Firestore за памет, задачи, workspace, OAuth сесии, потвърждения и audit;
- Google Identity Platform за вход и тестови профили;
- Claude Haiku 5.5 за основния разговор по подразбиране (избран в кода);
- OpenAI, Gemini и Grok като допълнителни AI двигатели при конфигурирани ключове;
- Claude като водещ кодов изпълнител в owner-controlled branch/PR поток (Codex
  вече не се използва);
- GitHub OAuth за read и защитени branch/commit/PR операции;
- Google OAuth за Drive, Gmail и Calendar;
- OAuth-защитен MCP адрес: `https://cloudaicore.com/mcp`.

Task Orchestrator разделя заявката на стъпки, избира capability и изпълнява
реалния адаптер. При кодова задача трите AI двигателя първо предлагат решения.
Claude синтезира ограничен набор от цели файлове, а записът
започва само след точно еднократно потвърждение. `main` никога не се променя
директно от задачата.

Паметта и всички данни са във Firestore, а входът е само през Identity
Platform. Старият вход през Supabase и старото хранилище OpenSearch са
премахнати. Локално, без Google Cloud проект, данните се пазят само в паметта
на процеса (режим `local`, никога в production).

## Локално стартиране

```bash
npm ci
cp .env.example .env
npm start
```

Попълни тайните само в локалния `.env` или Google Secret Manager. Не ги
commit-вай и не ги изпращай в чат.

## Проверка

```bash
npm test
```

Production acceptance изисква exact-SHA `/health`, зелено `/health/ready`,
Firestore + Identity Platform проверки, актуален MCP каталог и успешен
`synchron/production-smoke`.

Виж:

- `docs/OPERATIONS_RUNBOOK.md`
- `docs/CURRENT_PRODUCT_ACCEPTANCE.md`
- `docs/DEPLOYMENT_READINESS_CHECKLIST.md`
- `docs/OWNER_ACCEPTANCE_RUNBOOK.md`
- `docs/AVATAR_ROADMAP.md` (посока, фази, модел на парите)
- `docs/PRODUCT_DIRECTION.md`
- `docs/GOOGLE_CLOUD_CONFIGURATION_CATALOG.md`
