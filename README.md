# synchron-backend

## Runtime архитектура (активна)

- Source of truth: `server.js`
- Основни маршрути:
  - `POST /chat/chat`
  - `GET /health`
  - `GET|POST|DELETE /memory/*`
  - `GET /github/*`
  - `GET /calendar/*`
  - `GET /permissions/*`
  - `POST /confirmed-actions/*`
  - `GET|POST /api/google/*`
  - `POST /search/ai`
  - `GET /opensearch-status`

## Legacy

- `src/routes/index.js`
- `src/routes/cloudRouter.js`
- `services/logic-core` (архивиран, не е част от активния Node.js runtime)

## CI/CD

- Всеки push към main автоматично стартира тестове чрез GitHub Actions (виж .github/workflows/ci.yml).

## Lint и формат

- (След инсталация) Стартирай lint:
  ```
  npx eslint .
  ```
- Форматирай кода:
  ```
  npx prettier --write .
  ```

---

За въпроси и предложения: [maintainer email]
