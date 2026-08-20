# SYNCHRON-X AI CORE

Лична AI операционна система, достъпна на
[cloudaicore.com](https://cloudaicore.com). AI CORE разговаря, пази изолирана
памет и изпълнява само разрешени инструменти.

## Архитектура

- Node.js 22 + Express;
- Google Cloud Run production runtime;
- Firestore за памет, задачи, workspace, OAuth сесии, потвърждения и audit;
- Google Identity Platform за вход и тестови профили;
- OpenAI Responses API за основния разговор и coding ролята;
- Gemini и Grok за независими предложения в multi-engine задачи;
- GitHub OAuth за read и защитени branch/commit/PR операции;
- Google OAuth за Drive, Gmail и Calendar;
- OAuth-защитен MCP адрес: `https://cloudaicore.com/mcp`.

Task Orchestrator разделя заявката на стъпки, избира capability и изпълнява
реалния адаптер. При кодова задача трите AI двигателя първо предлагат решения.
OpenAI coding моделът синтезира ограничен набор от цели файлове, а записът
започва само след точно еднократно потвърждение. `main` никога не се променя
директно от задачата.

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
- `docs/OWNER_ACCEPTANCE_RUNBOOK.md`
- `docs/PRODUCT_DIRECTION.md`
- `docs/GOOGLE_CLOUD_CONFIGURATION_CATALOG.md`
