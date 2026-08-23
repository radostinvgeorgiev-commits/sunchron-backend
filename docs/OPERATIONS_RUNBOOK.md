# AI CORE operations runbook

## Production proof

```bash
curl --fail --silent --show-error https://cloudaicore.com/health
curl --fail --silent --show-error https://cloudaicore.com/health/ready
curl --fail --silent --show-error https://cloudaicore.com/health/dependencies
curl --silent --show-error https://cloudaicore.com/health/backups
curl --fail --silent --show-error https://cloudaicore.com/health/storage-report
curl --fail --silent --show-error https://cloudaicore.com/api/auth/session
```

Сравни `health.commit` с exact SHA на `main` и изчакай пет последователни
съвпадения. Провери `synchron/production-smoke`, Cloud Run revision, Firestore
и Identity Platform. Health status не доказва, че нов потребител реално може
да се регистрира — това се тества с изолиран профил.

## MCP

Изпрати JSON-RPC `tools/list` към `https://cloudaicore.com/mcp`. Каталогът
трябва да съдържа `get_google_cloud_runtime_status`, task capabilities и GitHub
write инструментите. За private tool очаквай 401 OAuth challenge със scope.

За една bounded проверка от аватара използвай
`get_google_cloud_project_diagnostics`. Тя проверява health/readiness, MCP
discovery, Cloud Run и Cloud Build trigger-а само за текущия project и service.
Резултат `PASS` означава, че всички проверки са изпълними; `PARTIAL` означава,
че публичните проверки са успешни, но runtime identity или някой upstream е
недостъпен. Инструментът е read-only и не стартира Cloud Shell, build, job или
deployment.

Разговорният аватар използва същия проверен capability engine. Read-only
заявките могат да върнат реален резултат в разговора; write заявките спират на
точна confirmation стъпка и не променят външна система преди owner потвърждение.

## Кодова задача

1. Влез като owner и свържи GitHub OAuth.
2. Задай точна, ограничена задача.
3. Провери предложенията на OpenAI, Gemini и Grok и списъка с файлове.
4. Потвърди само точния confirmation id.
5. Провери PR diff и CI.
6. След merge изчакай exact-SHA Cloud Run deployment и тествай в браузър.

## Rollback

За лош application commit създай отделен PR с `git revert <sha>`, пусни всички
тестове и повтори production proof. Не използвай force push и не изтривай
данни. Не стартирай restore/fork без показани цел, цена, cleanup и изрично
разрешение.

Owner acceptance е описан в `OWNER_ACCEPTANCE_RUNBOOK.md`.
