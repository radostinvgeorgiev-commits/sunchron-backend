# SYNCHRON-X — Google Cloud configuration catalog и migration gates

Този документ е planning-only граница за бъдещ Cloud Run migration. Той не
доказва създаден Google Cloud ресурс, няма secret стойност и не променя
текущия production deployment.

## Текуща authoritative граница

- DigitalOcean App Platform остава единственият production deployment канал.
- OpenSearch остава authoritative за личната и разговорната памет.
- Supabase остава authoritative за текущите тестови профили и сесии.
- Съществуващият `GOOGLE_CLIENT_*` поток е Google OAuth за Drive/Calendar/Gmail,
  а не Identity Platform migration.
- Firestore memory adapter-ът е изпълним само като изрично включен
  OpenSearch-first shadow mirror. Той е disabled-by-default, не е read source и
  няма cutover, data import, data migration или user import в този слой.
  Identity Platform и Vertex AI остават planning-only.
- Cloud Run template-ът е нарочно непълен: има placeholders и няма secret
  references, IAM binding, public invoker или DNS промяна.

## Non-secret configuration catalog

Тези полета са deploy-time configuration или документационни имена. Те не
трябва да се добавят в `.env`, да съдържат token стойности или да се показват
като runtime readiness без изпълним и приет адаптер.

| Област | Поле | Статус и граница |
| --- | --- | --- |
| Google Cloud | `GCP_PROJECT_ID` | Избира се изрично за изолирана среда; не се създава в този PR. |
| Google Cloud | `GCP_REGION` | Избира се с оглед latency, residency и цена; не се фиксира автоматично. |
| Artifact Registry | `ARTIFACT_REGISTRY_REPOSITORY` | Само бъдещо име на repository; image се публикува едва след отделно одобрение. |
| Cloud Run | `CLOUD_RUN_SERVICE_NAME` | Бъдещо име на service; placeholder в template-а. |
| Cloud Run | `CLOUD_RUN_RUNTIME_SERVICE_ACCOUNT` | Бъдещ runtime identity; IAM role grant не се прави тук. |
| Cloud Run | `IMAGE_URI` | Трябва да сочи към exact immutable image/commit, не към `latest`. |
| Runtime | `APP_COMMIT_SHA` | Задължителен exact provenance за `/health`; неизвестен SHA не е acceptance. |
| Runtime | `NODE_ENV` / `PORT` | `production` и `8080`; вече съществуващият Express contract се запазва. |
| Cloud Run | `containerConcurrency` / `timeoutSeconds` | Начални консервативни стойности са в template-а; променят се само след load/cost проверка. |

## Secrets и service identity

Cloud Run трябва да използва Application Default Credentials чрез runtime
service account. Не се добавя `GOOGLE_APPLICATION_CREDENTIALS`, JSON key или
secret стойност в image, YAML или Git.

Бъдещ Secret Manager mapping може да съдържа само одобрени имена/reference-и,
например:

- OpenSearch host/port/username/password и memory owner;
- OpenAI, Gemini и Grok API keys;
- Supabase session encryption key и tester invite code;
- GitHub/Google OAuth secrets и session encryption keys;
- MCP и само разрешените infrastructure diagnostics secrets.

Тези references не се създават, попълват или ротират в този слой. При бъдещ
staging deploy всеки reference трябва да има owner, IAM scope, rotation plan и
rollback plan. Липсващ или невалиден reference трябва да остави системата
not-ready, а не да активира fallback с друг secret.

## Firestore — изолиран shadow mirror

| Поле | Предназначение | Приемателна граница |
| --- | --- | --- |
| `FIRESTORE_DATABASE_ID` | Изрично избран sandbox database идентификатор | Не се provision-ва и не заменя OpenSearch. |
| `FIRESTORE_LOCATION` | Регион и data residency | Нужни са cost, residency и backup решения преди ресурс. |
| `FIRESTORE_COLLECTION_PREFIX` | Namespaced име на shadow колекциите | Няма production collections или import в този PR. |
| `FIRESTORE_ENABLED` | Feature flag за `mode=shadow` | Липсващ/`false` оставя OpenSearch-only поведението. |
| `FIRESTORE_REQUEST_TIMEOUT_MS` | Горна граница за best-effort mirror | Timeout не блокира chat, response или readiness. |

При `true` са задължителни `GCP_PROJECT_ID`, `FIRESTORE_DATABASE_ID`,
`FIRESTORE_LOCATION` и `FIRESTORE_COLLECTION_PREFIX`. Невалидната explicit
конфигурация е `misconfigured` и не активира fallback към друг project,
database, secret или provider. Authentication е само чрез Application Default
Credentials; не се добавят JSON keys или `GOOGLE_APPLICATION_CREDENTIALS`.
`FIRESTORE_EMULATOR_HOST` е разрешен само local/test и е невалиден в production.

OpenSearch винаги се изпълнява първи и остава authoritative за всички публични
read/response операции. След успешен profile write/delete или conversation turn
се изпраща best-effort Firestore mirror. Shadow failure се записва като
ограничен audit warning с operation, safe error code и hashed reference; не
връща съдържание, owner/session стойности или secrets и не променя
authoritative резултата.

Schema `v1` е описана в
[`firestore-indexes.v1.json`](./firestore-indexes.v1.json) и включва:

- namespaced profile memories с owner-bound deterministic document IDs;
- owner/session-bound conversation messages с idempotent turn IDs и
  транзакционна monotonic turn sequence;
- owner-bound conversation summaries с atomic transaction за turn и summary.

Index artifact-ът е документационен и не се provision-ва от този PR. Emulator
contract tests са opt-in и default `npm test` не прави live GCP calls.

## Identity Platform — бъдещ auth pilot

Бъдещият каталог може да съдържа `IDENTITY_PLATFORM_TENANT_ID`,
`IDENTITY_PLATFORM_PROJECT_ID`, provider IDs, authorized domains, redirect URI,
email verification, MFA и session policy. Това са configuration boundaries, не
готова интеграция.

Приемането започва само с изолиран тестов tenant/account и проверка на
signup → logout → login, session protection и rollback. Няма миграция на
Supabase users, sessions или лични профили, няма промяна на текущия Google OAuth
поток и няма DNS/authorized-domain промяна в този PR.

## Vertex AI — бъдещ provider pilot

Бъдещите non-secret полета са `VERTEX_AI_PROJECT_ID`,
`VERTEX_AI_LOCATION`, `VERTEX_AI_MODEL`, `VERTEX_AI_TIMEOUT_MS` и
`VERTEX_AI_ENABLED=false`. Достъпът трябва да е чрез runtime service account и
одобрена `roles/aiplatform.user` граница; ролята не се предоставя в този слой.

Vertex AI не се добавя директно в AI Core и не става fallback. Реален provider
трябва първо да има provider adapter, Capability Engine/Tool Registry boundary,
rate/cost limit, isolated smoke и изрично owner acceptance. До тогава текущият
OpenAI/Gemini/Grok contract остава непроменен.

## Cloud Run health contract

Cloud Run template-ът е в
[`deploy/cloud-run/service.yaml.template`](../deploy/cloud-run/service.yaml.template).

- `startupProbe` и `livenessProbe` използват `/health`, който публикува само
  безопасна версия/commit информация и не зависи от OpenSearch, AI или bridge.
- `/health/ready` остава по-тежката проверка на AI provider, OpenSearch,
  memory acceptance и bridge. Cloud Run не го използва като liveness probe.
- Readiness се приема чрез post-deploy smoke: exact image/commit, `/health`
  `200`, `/health/ready` `200` и съвпадащи runtime проверки.
- Няма `readinessProbe`, публичен invoker или ingress policy в този template;
  тези решения изискват отделен IAM, cost, edge и rollback review.

## Migration gates

| Gate | Нужно доказателство | Стоп условие |
| --- | --- | --- |
| 0. Baseline | Чист branch върху одобрения AI CORE commit, `npm test`, production audit и потвърдени текущи DigitalOcean health/smoke checks. | Непознат diff, dirty state или разминаване на SHA. |
| 1. Artifact | Локален `docker build` с exact commit и `docker run` smoke към `/health`; image-ът не съдържа `.env`/secret values. | `unknown` commit, лош probe, root runtime или липсващ порт 8080. |
| 2. Изолиран GCP staging | Избран project/region, показана цена, Artifact Registry, runtime service account и Secret Manager references с least privilege. | Нова платена услуга, IAM write или secret без изрично owner одобрение. |
| 3. Runtime acceptance | Cloud Run revision сочи exact immutable image; `/health`, `/health/ready` и безопасният smoke contract са зелени. | Readiness failure, dependency fallback, неочакван публичен достъп или неясен rollback. |
| 4. Data/identity pilot | Само sandbox Firestore schema + backup/restore и тестов Identity Platform tenant с signup/logout/login. | Import на production данни, Supabase cutover, изтриване или липсващ cleanup. |
| 5. Vertex pilot | Изолиран provider smoke, cost/quota ceiling, service-account scope и проверка през одобрен AI Core boundary. | Директен обход на Capability Engine, автоматичен fallback или production secret. |
| 6. Cutover/rollback | Отделно owner решение, доказан rollback към DigitalOcean и повторен exact-SHA acceptance; DNS се разглежда отделно. | DNS промяна, production migration или deploy без изрично разрешение. |

До преминаване на всички gates този документ описва само готовност за
планиране. Не представяй template, регистриран service account, започнат
deployment или наличен backup като production резултат.
