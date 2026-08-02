# SYNCHRON-X Bridge & Diagnostics

## Какво работи

SYNCHRON-X има MCP Streamable HTTP адрес `/mcp` и 13 инструмента: 11 само за
четене и два двустъпкови потвърждавани write flow-а. Освен GitHub cleanup,
мостът подготвя и потвърждава добавянето само на `www.synchron.foundation`
към предварително провереното DigitalOcean приложение. Основните read инструменти
включват:

- `get_personal_context`;
- `get_project_context`;
- `list_synchron_conversations`;
- `get_synchron_conversation`.

Legacy техническият достъп е ограничен с `MCP_ACCESS_TOKEN`. Новите OAuth
authorization codes, access tokens и refresh tokens използват отделния
`MCP_OAUTH_SECRET`, когато е конфигуриран. Нито една от стойностите не се
показва в диагностиката, логовете или отговорите.

## Диагностика

`GET /health/bridge` различава:

- `configured` — има валиден сървърен MCP токен;
- `reachable` — публичният диагностичен маршрут е достижим;
- `responding` — MCP обработчикът отговаря на `initialize`;
- `chatgptOAuthReady` — готово ли е поддържано свързване от ChatGPT.

Диагностиката не чете лична памет и не изпълнява AI заявка.

## Важна граница

Статичният bearer токен позволява защитен технически MCP достъп, но не е
завършен поддържан OAuth поток за лични данни в ChatGPT.

За `chatgptOAuthReady: true` са нужни отделно:

1. OAuth 2.1 authorization server с PKCE;
2. protected resource metadata;
3. `securitySchemes` за всеки инструмент;
4. проверка на issuer, audience, срок и scopes за всеки access token;
5. реален end-to-end тест от ChatGPT до разрешените read инструменти.

Тази стъпка не трябва да се симулира и не трябва да се реализира чрез
публичен достъп до личната памет.

## Миграция на OAuth ключа

Фаза 1 поддържа безопасен преход:

- без `MCP_OAUTH_SECRET` OAuth продължава със стария derivation от
  `MCP_ACCESS_TOKEN`;
- след добавяне на валиден `MCP_OAUTH_SECRET` всички нови OAuth артефакти се
  издават само с него;
- старите OAuth code/access/refresh артефакти временно остават валидни;
- refresh на стар token издава нов access и refresh token с dedicated ключа;
- `MCP_OAUTH_SECRET` никога не се приема като legacy static bearer.

Безопасен ред за фаза 2:

1. Генерирай случаен `MCP_OAUTH_SECRET` с поне 32 знака и го добави само като
   DigitalOcean runtime secret — никога в Git или в чат.
2. Провери нов OAuth вход, read tool call и refresh след отделен deployment.
3. Запази legacy OAuth verification fallback поне 30 дни — текущия refresh TTL.
4. След наблюдаван успешен преход премахни legacy OAuth verification fallback
   в отделен PR.
5. Едва след доказан owner OAuth acceptance ротирай или премахни
   `MCP_ACCESS_TOKEN` static bearer в отделна задача с rollback.
