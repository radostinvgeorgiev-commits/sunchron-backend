# SYNCHRON-X Bridge & Diagnostics

## Какво работи

SYNCHRON-X има MCP Streamable HTTP адрес `/mcp` и четири инструмента само за
четене:

- `get_personal_context`;
- `get_project_context`;
- `list_synchron_conversations`;
- `get_synchron_conversation`.

Достъпът е ограничен с `MCP_ACCESS_TOKEN`. Токенът не се показва в
диагностиката, логовете или отговорите.

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
5. реален end-to-end тест от ChatGPT до четирите read инструмента.

Тази стъпка не трябва да се симулира и не трябва да се реализира чрез
публичен достъп до личната памет.
