# Исторически документ — не е текущ roadmap

Този одит пази състоянието към посочения commit и дата. За актуалното
продуктово приемане и следващите стъпки използвай
[`../CURRENT_PRODUCT_ACCEPTANCE.md`](../CURRENT_PRODUCT_ACCEPTANCE.md).

# Технически одит на NOVARIUM / SYNCHRON-X

Дата: 31 юли 2026 г.
Проверен commit: `a394f4e9f93f6c87f2ef07d3d68eafffc48f1efe`

## Потвърдено

- GitHub `main` е на проверения commit.
- DigitalOcean production е потвърден на същия commit чрез независимата
  production проверка в PR №136.
- Публичният сайт, health, readiness и MCP са минали production проверката.
- Тестовите профили са потвърдени с:
  - `configured: true`;
  - `registrationEnabled: true`;
  - `projectConnection: true`;
  - `sessionProtection: true`.
- Supabase проектът `SYNCHRON-X` е `ACTIVE_HEALTHY`, PostgreSQL 17, регион
  `eu-central-1`.
- Supabase няма таблици в `public`, няма миграции и няма предупреждения от
  security или performance advisors.
- Пълният локален пакет има 325 теста: 324 успешни, 0 неуспешни и 1 пропуснат
  реален OpenSearch тест.
- Production npm зависимостите имат 0 известни уязвимости.
- Има CSP, HSTS, `X-Frame-Options`, други защитни headers и DOMPurify
  санитизация за AI Markdown.
- Не са открити записани частни ключове, GitHub personal tokens, OpenAI ключове
  или DigitalOcean access tokens в приложния код.

## Критични и високи констатации

### 1. Генерирани зависимости са записани в Git

В `main` са проследени:

- 10 133 файла от `node_modules`;
- 1 732 файла от `services/logic-core/venv`;
- `server.log`.

Това замърсява работните дървета, увеличава хранилището, затруднява проверките и
може да запази стари или уязвими локални зависимости. Поправката е да останат
само manifest и lock файловете, а зависимостите да се възстановяват с `npm ci`
и Python environment setup.

### 2. Няма доказан backup и restore на OpenSearch паметта

Health проверката доказва достъпност, но не доказва, че има работещ snapshot,
периодичен backup и възстановяване. Това е най-важният оставащ риск за
постоянната лична памет.

### 3. Реалният OpenSearch E2E тест още се пропуска

Има добри mock/integration тестове за изолация, замяна и точно изтриване на
факт. Единственият тест срещу истински OpenSearch се пропуска без production
credentials. Следващият тест трябва да използва изолиран временен owner и да
докаже запис, четене и изтриване без промяна на личната памет.

### 4. Tester auth проверката беше еднократна

PR №136 доказа production състоянието, но беше затворен без сливане. Затова
текущият периодичен production smoke не пази тестовите профили от бъдеща
регресия. Поправката добавя постоянна проверка на четирите безопасни булеви
флага.

## Средни констатации

- Dev зависимостите от тестовия инструментариум имат 22 high предупреждения
  през `brace-expansion/minimatch`. Production зависимостите са чисти.
  Автоматичната поправка изисква breaking upgrade на ESLint и не трябва да се
  слива без отделен тестов клон.
- GitHub има един отворен стар Draft PR №78. Той е конфликтен, проверява много
  стар commit и е заменен от този одит.
- Dedicated Supabase session secret и invite secret трябва да останат
  предпочитаният production вариант. Domain-separated fallback-ите са защита
  при липсваща runtime стойност, не окончателна secret-management стратегия.
- Няма потвърден branch protection/ruleset за `main` през наличния GitHub мост.

## Какво не е доказано

- истински AI разговор от production след последния deployment;
- истински OpenSearch запис/четене/изтриване на изолиран тестов факт;
- OpenSearch snapshot, restore и възстановяване след загуба;
- реална регистрация и вход на нов тестов потребител;
- GitHub write задача от чата с валидна собственическа OAuth сесия;
- Google Calendar/Drive/Gmail краен OAuth тест;
- DigitalOcean backups, firewall, разходи и rollback от самата платформа.

## Приоритет

1. Почистване на Git от генерирани зависимости и постоянен tester-auth smoke.
2. Доказан OpenSearch backup/restore.
3. Реален изолиран тест на паметта.
4. Един реален тестов потребител.
5. Краен тест на GitHub write и Google интеграциите.
