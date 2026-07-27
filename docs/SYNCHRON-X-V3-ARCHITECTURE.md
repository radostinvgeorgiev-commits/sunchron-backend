# SYNCHRON-X v3 — AI Core Architecture

## Основен принцип

SYNCHRON-X е един AI Core, който заявява способности. Capability Engine избира
подходящ инструмент от Tool Registry. AI Core и Logic Core не зависят от
конкретен доставчик.

## Поток

`Chat → AI Core → Logic Core → Capability Engine → Tool Registry → Tool`

Постоянната памет остава отделна основна услуга и продължава да използва
OpenSearch.

## Runtime source of truth (активно днес)

- Единствен runtime entrypoint: `/home/runner/work/sunchron-backend/sunchron-backend/server.js`.
- Активни маршрути от runtime:
  - `/chat`
  - `/health`
  - `/memory`
  - `/github`
  - `/calendar`
  - `/permissions`
  - `/confirmed-actions`
  - `/api/google`
  - `/search`
  - `/opensearch-status`

## Legacy (не е source of truth)

- `/home/runner/work/sunchron-backend/sunchron-backend/src/routes/index.js`
- `/home/runner/work/sunchron-backend/sunchron-backend/src/routes/cloudRouter.js`
- `/home/runner/work/sunchron-backend/sunchron-backend/services/logic-core` (архивиран референтен модул, не участва в текущия Node.js runtime)

Тези два файла са запазени за съвместимост и исторически контекст, но не са
основната runtime архитектура.

## Граници на прехода

Тази първа фаза:

- не променя Chat, AI Core, Logic Core, Memory или OpenSearch;
- не премахва екрана с 12-те области на личния аватар;
- регистрира само вече съществуващи и проверими инструменти;
- не изпълнява действия, а само избира инструмент и проверява разрешение;
- блокира неизвестни способности по подразбиране.

## Добавяне на интеграция

Нова интеграция трябва да изисква:

1. регистрация в Tool Registry;
2. декларация на capabilities и permissions;
3. адаптер, който изпълнява конкретната операция;
4. тестове за разрешения и потвърждение.

Не трябва да изисква промяна в AI Core или Logic Core.

## Следваща фаза

След одобрение съществуващите маршрути се свързват един по един към
Capability Engine. Старото им поведение остава достъпно, докато новият път не
мине същите тестове.

## Целеви модел за интеграции (преходен и краен)

### Вече минават през Capability Engine

- Чат заявки за `calendar.read`
- Чат заявки за `code.read` (GitHub read)

### Временно са директни маршрути

- `/search/ai`
- `/api/google/*`
- `/confirmed-actions/*`

### План за изравняване

1. Всяка директна интеграция да декларира capability и permission.
2. Изпълнението да се оркестрира през Capability Engine + Tool Registry.
3. Audit форматът да е единен: `action`, `decision`, `outcome`, `resource`, `details`, `sessionId`.
