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
- `get_google_cloud_project_diagnostics` — проверка само за четене за
  собственика. Включва health/readiness, MCP, Cloud Run, Cloud Build, Firestore,
  Monitoring, Logging, Resource Manager и метаданни за версиите на тайните.
  Връща PASS/PARTIAL/FAIL и сравнение на наблюдавания commit.
- `talk_to_novarium` / `send_message` — инструментален разговор през същия
  capability engine: read-only заявките се изпълняват реално, а GitHub,
  Google, памет и инфраструктурни записи се подготвят за отделно owner
  потвърждение.
- `save_conversation` — запазва разговор от Claude (или друг AI клиент) като
  нишка `claude-<uuid>` в Novarium за текущия профил; с `sessionId` добавя нови
  съобщения към същата нишка. До 50 съобщения на извикване, само роли
  `user`/`assistant`, scope `synchron:agent.chat`. Не пише в постоянната памет.
- `prepare_google_cloud_action` / `confirm_google_cloud_action` — owner-only, точни IAM, Cloud Run service identity или съществуващия `synchron-main-deploy` Cloud Build trigger за exact commit SHA, с еднократно потвърждение и audit журнал.

Project diagnostics използва фиксиран allowlist от Google Cloud API адреси и
метаданните на текущата Cloud Run service identity. Не приема shell команда,
произволен URL или произволен project/service target и не е заместител на
интерактивния Cloud Shell интерфейс.

Write инструментите са owner-only, имат най-тесен scope и изискват точна
еднократна фраза. Cloud Build trigger run е ограничен до `global`/`main`/
`synchron-main-deploy` и exact 40-символен commit SHA; не приема shell команда,
произволен trigger или произволен project. Backup и restore не са bridge операции. Те се проверяват в Google Cloud Console и не се стартират без
изрично разрешение.

Никога не поставяй OAuth code, access token, refresh token, API key или secret
стойност в issue, PR, лог или чат.
