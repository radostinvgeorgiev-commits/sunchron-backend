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

Write инструментите са owner-only, имат най-тесен scope и изискват точна
еднократна фраза. Backup и restore не са bridge операции. Те се проверяват в
Google Cloud Console и не се стартират без изрично разрешение.

Никога не поставяй OAuth code, access token, refresh token, API key или secret
стойност в issue, PR, лог или чат.
