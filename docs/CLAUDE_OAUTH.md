# Claude към AI CORE

Изключено по подразбиране. След одобрена промяна и deployment операторът
задава MCP_CLAUDE_OAUTH_ENABLED=true. Не се променят Google или ChatGPT grants.

В Claude → Plugins → Add custom connector:

- URL: https://cloudaicore.com/mcp
- Authentication: Sign in now
- OAuth client: Use your own OAuth client
- Client ID: synchron-claude
- Client secret: празно (public client с PKCE S256)
- Callback: https://claude.ai/api/mcp/auth_callback

Позволени са само synchron:read и offline_access. Не се споделят токени.
Реалният consent се преглежда преди предоставяне на достъп. Наличието на
конектор в списъка не доказва успешно удостоверяване или изпълнение.

Acceptance: OAuth вход от Claude, реален get_project_context, после същият
инструмент през ChatGPT и Gemini. Отнемането на Claude grant е отделно.
Запис и инфраструктурни промени не са разрешени на този клиент.
