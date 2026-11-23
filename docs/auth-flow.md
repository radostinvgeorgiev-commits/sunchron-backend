# Регистрация и вход

`/register` и `/` зареждат една страница. `public/app.js` изпраща
same-origin JSON към `/api/auth/register` и `/api/auth/login`. Браузърът не
използва Firebase SDK и не получава Identity Platform API ключ или authDomain.
Сървърът извиква Identity Toolkit REST със сървърния ключ; само браузърен ключ
с HTTP-referrer restriction няма да работи за тези сървърни заявки.

Регистрацията валидира входа и режима, създава Identity Platform потребител,
обновява името, изпраща писмо за потвърждение и записва approval документ в
Firestore. При публична регистрация сесия не се издава преди проверка на
имейла. Повторна регистрация със същите верни данни възстановява прекъснат
процес, без да презаписва съществуващо забранено approval. Входът проверява
паролата, профила, проверения имейл и approval документа. Само конкретният
първичен потребител е owner; останалите са member с отделен memory owner ID.

Сесията е криптирана в `HttpOnly`, `Secure`, `SameSite=Lax` cookie; Express
доверява един proxy hop на Cloud Run. CSP допуска само same-origin заявки,
за които CORS не е необходим. Проверка на реален HTTPS, Cloud Run маршрути и
настройки на Identity Platform след deployment е необходима.

Конфигурационни имена: `AUTH_BACKEND`, `IDENTITY_PLATFORM_PROJECT_ID`,
`GOOGLE_CLOUD_PROJECT`, `GCLOUD_PROJECT`, `GCP_PROJECT_ID`,
`IDENTITY_PLATFORM_API_KEY`, `IDENTITY_PLATFORM_TIMEOUT_MS`,
`IDENTITY_PLATFORM_REQUIRE_EMAIL_VERIFICATION`, `USER_SESSION_ENCRYPTION_KEY`,
`USER_REGISTRATION_MODE`, `SYNCHRON_TEST_INVITE_CODE`,
`SYNCHRON_PRIMARY_USER_ID`, `MEMORY_OWNER_ID`, `PERSISTENCE_BACKEND`,
`FIRESTORE_DATABASE_ID`, `FIRESTORE_TESTER_ACCESS_COLLECTION`, `NODE_ENV`.
Публичната регистрация винаги изисква потвърден имейл. В invite режима е нужен
код за покана. API грешките връщат безопасен код и съобщение на български;
структурираните събития съдържат стъпка, резултат, безопасен upstream код и
request ID, без имейл, парола, ключ или token.
