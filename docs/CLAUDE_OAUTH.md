# Claude към AI CORE

Изключено по подразбиране. След одобрена промяна и deployment операторът
задава MCP_CLAUDE_OAUTH_ENABLED=true. Не се променят Google или ChatGPT grants.

В Claude → Plugins → Add custom connector:

- URL: https://cloudaicore.com/mcp
- Authentication: Sign in now
- OAuth client: Use your own OAuth client
- Client ID: synchron-claude (в Advanced settings; без него Claude опитва
  динамична регистрация, която AI CORE не поддържа)
- Client secret: празно (public client с PKCE S256)
- Callback: https://claude.ai/api/mcp/auth_callback

Един вход дава synchron:read, synchron:agent.chat и offline_access, каквото
и да поиска Claude. Claude иска правото на първия извикан инструмент, а при
403 само липсващото; без пакета конекторът остава в „Sign-in required“.
Права за запис и owner-only права се отказват. Не се споделят токени.
Реалният consent се преглежда преди предоставяне на достъп. Наличието на
конектор в списъка не доказва успешно удостоверяване или изпълнение.

Acceptance: OAuth вход от Claude, реален get_project_context, после същият
инструмент през ChatGPT и Gemini. Отнемането на Claude grant е отделно.
Запис и инфраструктурни промени не са разрешени на този клиент.
