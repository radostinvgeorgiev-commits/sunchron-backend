# AI CORE MVP acceptance checklist

Този checklist превръща препоръката на AI CORE Council в минимален, проверим
критерий за готовност на MVP. Всеки сценарий има доказателство и резултат
`PASS`/`FAIL`/`PENDING`; MVP не се обявява за готово при `PENDING` или `FAIL`.

## Предусловия

- [ ] Owner профилът е потвърден в `https://cloudaicore.com`.
- [ ] `/health` връща exact SHA от production `main`.
- [ ] `/health/ready` е `ready`, Firestore е healthy и MCP/OAuth е reachable.
- [ ] Използва се само минималният необходим scope; secrets и tokens не се
      копират в отчета.

## Пет acceptance сценария

| ID | Сценарий | Критерий за PASS | Доказателство | Резултат |
|---|---|---|---|---|
| A1 | Стабилен разговор | Owner изпраща съобщение, получава смислен отговор, презарежда сесията и вижда контекста без 5xx/дублиране. | URL, timestamp, session id, screenshot/log без tokens | PASS_OWNER_BROWSER |
| A2 | Жизнен цикъл на паметта | С точно потвърждение се записва тестов факт, той се извлича в нова сесия и се изтрива с точно потвърждение; след изтриване не се извлича. | Memory/audit записи и timestamp-и | PASS_OWNER_BROWSER |
| A3 | Отказ на неразрешено действие | Заявка извън allowlist или без нужния scope се отказва преди външен side effect и отказът се записва в audit. | Отговорът за отказ + audit event | PASS_OWNER_BROWSER |
| A4 | Потвърдено разрешено действие | Allowlisted действие спира на confirmation gate, изпълнява се едва след точно owner потвърждение и оставя audit запис с резултат. | Confirmation id, audit event, безопасен резултат | PASS_PARTIAL_AUDIT_READ_PENDING |
| A5 | Възстановяване при API грешка | Временен upstream/API отказ връща контролиран отговор, не губи сесията и след възстановяване следващата заявка работи. | Error/recovery logs и повторен успешен отговор | PASS_LOCAL_STAGING_PENDING |

## Безопасни проверки, изпълнени досега

- Production сайтът отговаря и показва AI CORE/аватар „Капка — Готово за
  преглед“; интерфейсът показва „Сървър онлайн“.
- `/health` е `ok` на commit
  `18912a2a739f6caafeefc643a8d9c9b256b02c6e`; `/health/ready` е `ready`,
  Firestore е `green`, а MCP bridge е reachable/responding с 45 инструмента.
- ChatGPT OAuth връзката завърши с `authorization_code` token exchange.
- Сайтът показва активни ChatGPT MCP връзки и 9 разрешения; `agent.chat` и
  `memory.read` са разрешени, а `memory.write` остава confirmation-gated.
- Локалните безопасни проверки: **91 PASS, 0 FAIL** (аватарен контекст,
  OAuth/MCP, memory confirmation/isolation и health/integration тестове).
- Изолираният memory acceptance тест потвърждава, че временният owner не
  променя реалната памет.
- Owner browser A1 (2026-08-23): `MVP-A1 smoke test` върна `A1-PASS`; след
  презареждане същият отговор остана в разговора.
- Owner browser A3 (2026-08-23): заявка за изпращане на имейл без потвърждение
  беше отказана с „липсва изрично owner потвърждение“; не е извършено
  външно действие.
- Owner browser A2 (2026-08-23): синтетичният факт
  `MVP_A2_TEST_2026_08_23=GREEN` беше записан с еднократно потвърждение,
  извлечен като `GREEN` в нов разговор, изтрит с отделно потвърждение и след
  нов разговор върна „Не знам“; лична памет не е използвана.
- A4 partial: A2 използва реален allowlisted `memory.write` confirmation gate и
  успешен резултат; локалните permission/task тестове потвърждават intent →
  adapter → outcome audit. През свързания ChatGPT AI CORE 1 конектор
  `list_action_history` е наличен, но production извикването върна
  `UNAVAILABLE` („SYNCHRON-X временно не може да изпълни заявката“); няма
  направена промяна. Production audit read остава за отделен read-only
  adapter/runtime тест.
- A5 local: **33 PASS, 0 FAIL** в chat resilience, task execution/orchestration,
  confirmation security и production smoke тестовете; покрити са upstream
  503/memory unavailable recovery пътища. Реален staging fault injection още
  не е изпълнен.

Тези проверки доказват свързаност и готова защитна граница, но не заменят
owner acceptance сценариите A1–A5.

## Решение за MVP

- [ ] Всички A1–A5 са `PASS` с приложено доказателство.
- [ ] Няма непотвърден write/delete acceptance в production.
- [ ] Резултатите са прегледани от owner.

**Текущо решение:** `NOT READY — acceptance evidence pending`.
