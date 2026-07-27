# synchron-backend
# synchron-backend

## Runtime архитектура (активна)

- Source of truth: `/home/runner/work/sunchron-backend/sunchron-backend/server.js`
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

- `/home/runner/work/sunchron-backend/sunchron-backend/src/routes/index.js`
- `/home/runner/work/sunchron-backend/sunchron-backend/src/routes/cloudRouter.js`
- `/home/runner/work/sunchron-backend/sunchron-backend/services/logic-core` (архивиран, не е част от активния Node.js runtime)

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
