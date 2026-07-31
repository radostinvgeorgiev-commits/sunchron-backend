# SYNCHRON-X Bridge & Diagnostics

## Какво работи

SYNCHRON-X има MCP Streamable HTTP адрес `/mcp` и четири инструмента само за
четене:

- `get_personal_context`;
- `get_project_context`;
- `list_synchron_conversations`;
- `get_synchron_conversation`.

Достъпът до инструментите се дава чрез scoped OAuth access token или чрез
legacy `MCP_ACCESS_TOKEN`. Тайните не се показват в диагностиката, логовете или
отговорите. Когато е зададен `MCP_OAUTH_SECRET`, новите OAuth артефакти се
криптират отделно от legacy bearer credential.

## Диагностика

`GET /health/bridge` различава:

- `configured` — има валиден сървърен MCP токен;
- `reachable` — публичният диагностичен маршрут е достижим;
- `responding` — MCP обработчикът отговаря на `initialize`;
- `chatgptOAuthReady` — готово ли е поддържано свързване от ChatGPT.

Диагностиката не чете лична памет и не изпълнява AI заявка.

## Важна граница

Статичният bearer токен остава временен compatibility път и заобикаля OAuth
scopes. Планът за безопасното му отделяне и последващо премахване е в
`MCP_OAUTH_SECRET_MIGRATION.md`.

За `chatgptOAuthReady: true` са нужни отделно:

1. OAuth 2.1 authorization server с PKCE;
2. protected resource metadata;
3. `securitySchemes` за всеки инструмент;
4. проверка на issuer, audience, срок и scopes за всеки access token;
5. реален end-to-end тест от ChatGPT до четирите read инструмента.

Тази стъпка не трябва да се симулира и не трябва да се реализира чрез
публичен достъп до личната памет.
