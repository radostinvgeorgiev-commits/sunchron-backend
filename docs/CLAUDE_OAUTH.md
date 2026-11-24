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

## GitHub App за едно хранилище

Операторът създава GitHub App, задава callback
`https://cloudaicore.com/api/github/callback` и я инсталира само за
`GITHUB_REPOSITORY`. Нужни са repository permissions Contents, Pull requests и
Issues: Read and write; Actions и Checks: Read-only. След това конфигурира
`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_APP_ID`,
`GITHUB_APP_INSTALLATION_ID` и `GITHUB_APP_PRIVATE_KEY` чрез защитената
конфигурация на услугата, без да ги записва в хранилището. Нужен е и
`GITHUB_SESSION_ENCRYPTION_KEY`.

След deployment собственикът трябва отново да свърже GitHub профила си. Старите
OAuth сесии и `GITHUB_TOKEN` не се използват; старата OAuth оторизация трябва
отделно да се отнеме от GitHub настройките. Installation token изтича след
около час и засега е необходимо повторно свързване. Не е правена реална
инсталация или проверка на този поток.

Claude може да подготвя GitHub branch/file/draft PR. Не може да потвърждава
директно, да слива PR, да прави deployment, променя IAM или чете Secret
Manager. Собственикът преглежда точната промяна на `/claude-confirm.html`
и отделно потвърждава. Произволен deployment може да изложи runtime тайни,
дори когато няма директни Secret Manager права.

Acceptance след deployment: действителен OAuth вход и диагностика, разговор,
преглед и изрично потвърждение на безопасна пробна GitHub промяна; отделно
проверете, че ChatGPT и Gemini не са засегнати. Не потвърждавайте deployment
само заради този тест. Отнемането на Claude grant е отделно.
