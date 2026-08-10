# SYNCHRON-X — Google Cloud configuration catalog и migration gates

Този документ е текущият регистър за поетапната Cloud Run migration. Той няма
secret стойности и не променя текущия production deployment преди отделен
приет cutover.

## Текуща authoritative граница

- DigitalOcean App Platform остава единственият production deployment канал.
- OpenSearch остава authoritative за личната и разговорната памет.
- Supabase остава authoritative за текущите тестови профили и сесии.
- Google Cloud project `handy-boulevard-479120-q9` има частен Cloud Run staging,
  runtime service account и Firestore `(default)` в `europe-west1`.
- Firestore runtime adapter-ът за памет, разговори, еднократни потвърждения и
  audit journal е изпълним в отделен branch, но още няма exact-SHA staging
  acceptance или мигрирани production данни.
- Съществуващият `GOOGLE_CLIENT_*` поток е Google OAuth за Drive/Calendar/Gmail,
  а не Identity Platform migration.
- Identity Platform и Vertex AI остават planning-only. Няма user import,
  Supabase cutover или Vertex provider acceptance.
- Cloud Run template-ът е нарочно непълен: има placeholders и няма secret
  references, IAM binding, public invoker или DNS промяна.

## Non-secret configuration catalog

Тези полета са deploy-time configuration или документационни имена. Те не
трябва да се добавят в `.env`, да съдържат token стойности или да се показват
като runtime readiness без изпълним и приет адаптер.

| Област            | Поле                                      | Статус и граница                                                                           |
| ----------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------ |
| Google Cloud      | `GOOGLE_CLOUD_PROJECT`                    | `handy-boulevard-479120-q9` за изолирания staging.                                         |
| Google Cloud      | `GCP_REGION`                              | `europe-west1` за Cloud Run и Firestore.                                                   |
| Artifact Registry | `ARTIFACT_REGISTRY_REPOSITORY`            | Само бъдещо име на repository; image се публикува едва след отделно одобрение.             |
| Cloud Run         | `CLOUD_RUN_SERVICE_NAME`                  | Staging service: `synchron-backend-staging`.                                               |
| Cloud Run         | `CLOUD_RUN_RUNTIME_SERVICE_ACCOUNT`       | Отделна service identity с `roles/datastore.user`.                                         |
| Cloud Run         | `IMAGE_URI`                               | Трябва да сочи към exact immutable image/commit, не към `latest`.                          |
| Runtime           | `APP_COMMIT_SHA`                          | Задължителен exact provenance за `/health`; неизвестен SHA не е acceptance.                |
| Runtime           | `NODE_ENV` / `PORT`                       | `production` и `8080`; вече съществуващият Express contract се запазва.                    |
| Cloud Run         | `containerConcurrency` / `timeoutSeconds` | Начални консервативни стойности са в template-а; променят се само след load/cost проверка. |

## Secrets и service identity

Cloud Run трябва да използва Application Default Credentials чрез runtime
service account. Не се добавя `GOOGLE_APPLICATION_CREDENTIALS`, JSON key или
secret стойност в image, YAML или Git.

Secret Manager mapping може да съдържа само одобрени имена/reference-и,
например:

- OpenSearch host/port/username/password и memory owner;
- OpenAI, Gemini и Grok API keys;
- Supabase session encryption key и tester invite code;
- GitHub/Google OAuth secrets и session encryption keys;
- MCP и само разрешените infrastructure diagnostics secrets.

OpenAI reference-ът е проверен в staging без показване на стойността. Останалите
references не се приемат за готови само защото има празен secret container. При
всеки staging deploy всеки reference трябва да има owner, IAM scope, rotation plan и
rollback plan. Липсващ или невалиден reference трябва да остави системата
not-ready, а не да активира fallback с друг secret.

## Firestore — изпълним staging data plane

| Поле                                | Предназначение          | Приемателна граница                                                   |
| ----------------------------------- | ----------------------- | --------------------------------------------------------------------- |
| `MEMORY_BACKEND`                    | Избор на memory adapter | `firestore` само в GCP staging; DigitalOcean остава `opensearch`.     |
| `PERSISTENCE_BACKEND`               | Потвърждения и audit    | `firestore` само в GCP staging.                                       |
| `FIRESTORE_DATABASE_ID`             | Database идентификатор  | `(default)`, Firestore Native, Standard.                              |
| `FIRESTORE_PROFILE_COLLECTION`      | Лична/проектна памет    | Owner-isolated документи със стабилен хеширан ID.                     |
| `FIRESTORE_CONVERSATION_COLLECTION` | Разговори               | Owner и session isolation; атомичен запис на двата message документа. |
| `FIRESTORE_CONFIRMATION_COLLECTION` | Потвърждения            | Криптирани и еднократни; delete-before-execute.                       |
| `FIRESTORE_AUDIT_COLLECTION`        | Audit journal           | Durable intent/outcome записи без raw confirmation ID.                |

Unit/integration тестовете трябва да доказват owner isolation, атомично
create/update/delete, деветстъпковия memory acceptance, fail-closed readiness и
липса на secret стойности в грешки. Реалният staging тест използва само изолиран
owner; production import и OpenSearch cutover са забранени преди backup/rollback.

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
- `/health/ready` остава по-тежката проверка на AI provider, избрания memory backend,
  memory acceptance и bridge. Cloud Run не го използва като liveness probe.
- Readiness се приема чрез post-deploy smoke: exact image/commit, `/health`
  `200`, `/health/ready` `200` и съвпадащи runtime проверки.
- Няма `readinessProbe`, публичен invoker или ingress policy в този template;
  тези решения изискват отделен IAM, cost, edge и rollback review.

## Migration gates

| Gate                    | Нужно доказателство                                                                                                             | Стоп условие                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 0. Baseline             | Чист branch върху одобрения AI CORE commit, `npm test`, production audit и потвърдени текущи DigitalOcean health/smoke checks.  | Непознат diff, dirty state или разминаване на SHA.                                     |
| 1. Artifact             | Локален `docker build` с exact commit и `docker run` smoke към `/health`; image-ът не съдържа `.env`/secret values.             | `unknown` commit, лош probe, root runtime или липсващ порт 8080.                       |
| 2. Изолиран GCP staging | Избран project/region, показана цена, Artifact Registry, runtime service account и Secret Manager references с least privilege. | Нова платена услуга, IAM write или secret без изрично owner одобрение.                 |
| 3. Runtime acceptance   | Cloud Run revision сочи exact immutable image; `/health`, `/health/ready` и безопасният smoke contract са зелени.               | Readiness failure, dependency fallback, неочакван публичен достъп или неясен rollback. |
| 4. Data pilot           | Firestore adapter tests + реален изолиран owner acceptance + backup/restore план.                                               | Import на production данни, OpenSearch cutover, изтриване или липсващ cleanup.         |
| 5. Identity pilot       | Тестов Identity Platform account с signup/logout/login и owner isolation.                                                       | Supabase cutover или user import без rollback.                                         |
| 6. Vertex pilot         | Изолиран provider smoke, cost/quota ceiling, service-account scope и проверка през одобрен AI Core boundary.                    | Директен обход на Capability Engine, автоматичен fallback или production secret.       |
| 7. Cutover/rollback     | Отделно owner решение, доказан rollback към DigitalOcean и повторен exact-SHA acceptance; DNS се разглежда отделно.             | DNS промяна, production migration или deploy без изрично разрешение.                   |

До преминаване на всички gates не представяй template, регистриран service
account, staging deployment или наличен backup като production резултат.
