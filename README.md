# SYNCHRON-X

SYNCHRON-X е лична AI операционна система, която познава човека, има
постоянна контролирана памет и използва разрешени инструменти за изпълнение
на реални задачи. За всяка задача тя може да избира най-подходящия AI модел,
вместо да зависи от един-единствен AI.

AI аватарът е интерфейсът на системата — лицето, гласът, характерът и начинът
на общуване. Той не е цялата система.

SYNCHRON-X обединява:

- стабилен AI разговор;
- контролиран личен и проектен контекст;
- постоянна памет чрез избираем server-side adapter; production още е
  OpenSearch, а Google staging кандидатът е Firestore;
- AI аватар като слой за общуване;
- разрешени инструменти за реални задачи;
- потвърждение преди рискови действия.

## Основен поток

`Сайт → SYNCHRON-X server → избран AI provider → отговор`

OpenAI Responses API е доставчикът по подразбиране. Gemini и Grok от xAI могат
да се изберат чрез `AI_CORE_PROVIDER` и собствените им secrets. Паметта и
разрешените инструменти се добавят към този поток през сървърните адаптери.
DigitalOcean App Platform хоства приложението, но не е разговорен AI доставчик.

Инструментите се избират през `Capability Engine` и `Tool Registry`. Регистрация
без изпълним адаптер и конфигурация не се счита за работеща интеграция.

## Конфигурация

Имената на нужните променливи са в `.env.example`. Реалните ключове се пазят
само в управляваните secret хранилища на активната среда — DigitalOcean за
текущия production и Secret Manager за Google staging — и не се записват в
GitHub.

Безопасният статус на връзките е достъпен на:

`GET /health/integrations`

Той показва само дали конфигурацията е налична, без стойности на ключове.

## Проверка

```bash
npm ci
npm test
```

Всеки push и pull request към `main` стартира автоматичните проверки.

За проверка на точния production commit, readiness, MCP, memory acceptance и
безопасен incident/rollback ред използвай
[`docs/OPERATIONS_RUNBOOK.md`](docs/OPERATIONS_RUNBOOK.md). Не приемай стара
тестова бройка или commit от исторически audit за текущо състояние.

Актуалното разделение между потвърдено, release candidate и още неприето е в
[`docs/CURRENT_PRODUCT_ACCEPTANCE.md`](docs/CURRENT_PRODUCT_ACCEPTANCE.md).
Този документ е текущият roadmap; старите технически одити са само архив.

Приетата по-дългосрочна продуктова посока, UX изискванията и безопасният ред за
оценка на външни инструменти са в
[`docs/PRODUCT_DIRECTION.md`](docs/PRODUCT_DIRECTION.md). Кандидат в този
документ не означава внедрена или работеща production интеграция.

Google Cloud migration се изпълнява поетапно, без да променя текущия production
канал преди отделен cutover. Firestore има server-side adapter кандидати за
памет, operational state, workspaces, tasks, криптирани GitHub/Google OAuth
сесии и MCP grants/replay, а Identity Platform — за профили; това още не е
data/user/session migration. Каталогът, Cloud Run health contract-ът и migration gates са в
[`docs/GOOGLE_CLOUD_CONFIGURATION_CATALOG.md`](docs/GOOGLE_CLOUD_CONFIGURATION_CATALOG.md).
Staging manifest се render-ва само от immutable image digest и фиксирани Secret
Manager версии чрез `npm run gcp:render:staging`; след deploy read-only
acceptance се изпълнява с `npm run gcp:verify:staging`.
