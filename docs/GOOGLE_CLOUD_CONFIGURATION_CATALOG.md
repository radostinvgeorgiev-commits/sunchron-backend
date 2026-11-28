# Google Cloud production configuration

## Runtime

- Cloud Run service с immutable Artifact Registry image digest;
- runtime service account с least privilege;
- Firestore `(default)` database и owner isolation;
- Identity Platform с email verification;
- Secret Manager references, без secret стойности в manifest или Git;
- canonical DNS и OAuth origin: `https://cloudaicore.com`.

## AI за сайта: Vertex AI в Google Cloud

Сървърните AI заявки на сайта трябва да използват Vertex AI през прикрепения
Cloud Run service account и Application Default Credentials (ADC). Не използвай
OpenAI, Anthropic, xAI или API keys за модели; не добавяй service-account JSON
ключове.

Настрой следните non-secret runtime стойности:

- `VERTEX_AI_ENABLED=true`;
- `AI_CORE_PROVIDER=vertex-gemini`;
- `VERTEX_AI_PROJECT_ID=<валиден Google Cloud project ID>`;
- `VERTEX_AI_LOCATION=us-central1` (или друг разрешен регион);
- `VERTEX_AI_MODEL=gemini-2.5-flash`;
- `VERTEX_AI_TIMEOUT_MS=30000` (адаптерът прилага безопасна граница).

При липсваща ADC конфигурация или недостатъчен IAM достъп заявката спира
fail-closed. Старите запазени избори на OpenAI, Claude, Grok и директния Gemini
се мигрират към Vertex Gemini; в интерфейса се показват само моделите на Google.
Това описание указва целевата конфигурация на PR-а; само merge и отделно
одобрен production deploy променят production runtime.

## Задължителни runtime стойности

- `MEMORY_BACKEND=firestore`
- `PERSISTENCE_BACKEND=firestore`
- `AUTH_BACKEND=identity-platform`
- `GOOGLE_CLOUD_PROJECT`
- `IDENTITY_PLATFORM_PROJECT_ID`
- `MCP_RESOURCE_URL=https://cloudaicore.com/mcp`

Firestore runtime adapter-ът пази памет, разговори, workspace, задачи,
потвърждения, audit и криптирани OAuth сесии. Composite index-ите са в
`firestore.indexes.json`.

## Cloud Run health contract

`/health` е startup/liveness и exact-SHA proof. `/health/ready` проверява
зависимостите. `/health/storage-report` проверява Firestore и Identity Platform,
но не твърди restore готовност без отделен тест.

## Deployment gates

1. `npm test` и `git diff --check`.
2. Branch/PR и зелен CI.
3. Immutable image за exact commit.
4. Cloud Run revision със Secret Manager references и service identity.
5. Exact-SHA production smoke.
6. Browser acceptance с owner и отделен тестов профил.

Няма директен production import, IAM write, DNS промяна, secret rotation или
restore без отделно разрешение и rollback план.
