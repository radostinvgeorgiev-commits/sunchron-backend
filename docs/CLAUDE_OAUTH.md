# Claude към AI CORE

Изключено по подразбиране. След одобрена промяна и deployment операторът
включва `MCP_CLAUDE_OAUTH_ENABLED`. Не се променят Google или ChatGPT grants.

В Claude → Plugins → Add custom connector:

- URL: https://cloudaicore.com/mcp
- Authentication: Sign in now
- OAuth client: Use your own OAuth client
- Client ID: synchron-claude
- Client secret: празно (public client с PKCE S256)
- Callback: https://claude.ai/api/mcp/auth_callback

Позволени са `synchron:read`, `synchron:agent.chat`, `synchron:github.write`,
`synchron:audit.read` и `offline_access`.
Съществуващите широки scopes се ограничават допълнително до изрично изброени
инструменти за Claude. Достъпът е само за owner. Разговорът с AI CORE не може
да стартира инструменти или да потвърждава действия. Не се споделят токени.
Реалният consent се преглежда преди предоставяне на достъп. Наличието на
конектор в списъка не доказва успешно удостоверяване или изпълнение.

Claude може да подготвя GitHub branch/file/draft PR. Не може да потвърждава
директно, да слива PR, да прави deployment, променя IAM или чете Secret
Manager. Собственикът преглежда точната промяна на `/claude-confirm.html`
и отделно потвърждава. Произволен deployment може да изложи runtime тайни,
дори когато няма директни Secret Manager права.

Acceptance след deployment: действителен OAuth вход и диагностика, разговор,
преглед и изрично потвърждение на безопасна пробна GitHub промяна; отделно
проверете, че ChatGPT и Gemini не са засегнати. Не потвърждавайте deployment
само заради този тест. Отнемането на Claude grant е отделно.
