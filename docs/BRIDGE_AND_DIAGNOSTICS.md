# MCP и диагностика

Публичният MCP ресурс е `https://cloudaicore.com/mcp`. Той е Streamable HTTP
маршрут на същото Cloud Run приложение и използва OAuth 2.1 scopes.

## Безопасни проверки

- `GET /health` — liveness и exact commit;
- `GET /health/ready` — AI, Firestore и bridge readiness;
- `GET /health/storage-report` — Firestore/Identity Platform и честен backup
  статус;
- анонимен MCP `tools/list` — актуален каталог;
- `get_google_cloud_runtime_status` — read-only runtime metadata без secrets.
- `get_google_cloud_project_diagnostics` — owner-scoped read-only проверка на
  публичния health/readiness, MCP каталога, Cloud Run service и Cloud Build
  trigger-а; връща PASS/PARTIAL/FAIL и сравнение на наблюдавания commit.
- `prepare_google_cloud_action` / `confirm_google_cloud_action` — owner-only, точни IAM и Cloud Run service identity промени с еднократно потвърждение и audit журнал.

Project diagnostics използва фиксиран allowlist от Google Cloud API адреси и
метаданните на текущата Cloud Run service identity. Не приема shell команда,
произволен URL или произволен project/service target и не е заместител на
интерактивния Cloud Shell интерфейс.

Write инструментите са owner-only, имат най-тесен scope и изискват точна
еднократна фраза. Backup и restore не са bridge операции. Те се проверяват в
Google Cloud Console и не се стартират без изрично разрешение.

Никога не поставяй OAuth code, access token, refresh token, API key или secret
стойност в issue, PR, лог или чат.
