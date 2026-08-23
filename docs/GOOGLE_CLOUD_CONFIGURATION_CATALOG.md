# Google Cloud production configuration

## Runtime

- Cloud Run service с immutable Artifact Registry image digest;
- runtime service account с least privilege;
- Firestore `(default)` database и owner isolation;
- Identity Platform с email verification;
- Secret Manager references, без secret стойности в manifest или Git;
- canonical DNS и OAuth origin: `https://cloudaicore.com`.

## Опционален Vertex AI Gemini

Vertex AI Gemini е отделен, изрично включван provider и не заменя OpenAI,
директния Gemini API или Grok. За Cloud Run използвай прикрепения service
account и Application Default Credentials (ADC) с cloud-platform scope; не
добавяй service-account JSON ключове или API keys.

Задай само следните non-secret runtime настройки, когато искаш Vertex:

- `VERTEX_AI_ENABLED=true`;
- `AI_CORE_PROVIDER=vertex-gemini`;
- `VERTEX_AI_PROJECT_ID=<валиден Google Cloud project ID>`;
- `VERTEX_AI_LOCATION=us-central1` (или друг разрешен регион);
- `VERTEX_AI_MODEL=gemini-2.5-flash`;
- `VERTEX_AI_TIMEOUT_MS=30000` (адаптерът прилага безопасна граница).

При липсваща ADC конфигурация или недостатъчен IAM достъп заявката спира
fail-closed. Disabled Vertex не влияе на OpenAI readiness. Старият
`gemini-2.5-flash` work-mode избор продължава да използва директния Gemini API;
за Vertex има отделен избор `vertex-gemini-2.5-flash`.

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
