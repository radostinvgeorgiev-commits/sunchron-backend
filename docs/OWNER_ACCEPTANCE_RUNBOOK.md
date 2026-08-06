# SYNCHRON-X owner acceptance runbook

Този runbook доказва реалната owner връзка към ChatGPT MCP, GitHub и Google.
Той не променя production конфигурация и не е разрешение за write действие.

## Задължителни граници

- Изпълнявай acceptance само с owner профила на SYNCHRON-X.
- Започвай с read-only проверките.
- За всяко външно write действие следвай отделно:
  `prepare → преглед на въздействието → точно потвърждение → execute → verify → cleanup`.
- Не приемай общо „да“, старо потвърждение или потвърждение за друг ресурс.
- Не записвай access token, refresh token, cookie, authorization code, secret,
  лично писмо, календарно съдържание или лична памет в PR, issue, screenshot или log.
- Не стартирай write acceptance от CI, scheduled workflow или production smoke.
- Не променяй secret, OAuth scope или `COPILOT_AUTOMATION_ENABLED`, за да накараш
  теста да мине.
- Спри при грешен owner, различен target, липсващ cleanup план или неочакван
  write резултат.

## Предварителна проверка

Преди всяка acceptance сесия изпълни read-only реда от
[`OPERATIONS_RUNBOOK.md`](./OPERATIONS_RUNBOOK.md) и запиши само:

- UTC дата и кратък acceptance run ID;
- SHA на `main`;
- SHA от `/health`;
- `status` от `/health/ready`;
- състоянието на `synchron/production-smoke` за същия SHA.

Продължи само ако двата SHA съвпадат, readiness е `ready`, memory acceptance е
изолиран и production smoke е успешен.

## 1. ChatGPT MCP — read-only owner acceptance

Официалният OpenAI процес за developer връзка е описан в
[Connect and test your plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt).

1. В ChatGPT отвори **Settings → Security and login** и включи Developer mode.
   Наличността може да зависи от профила или workspace policy.
2. Отвори ChatGPT Plugins, добави нова връзка и въведи публичния Streamable
   HTTP адрес `https://synchron.foundation/mcp`.
3. Прегледай откритите инструменти и техните annotations. Не продължавай, ако
   каталогът е различен от production smoke договора.
4. Започни нов разговор, избери връзката и поискай точно read-only инструмента
   `get_system_configuration`.
5. Завърши OAuth входа със SYNCHRON-X owner профила. Не копирай token или code.
6. Провери, че резултатът е model-readable, не съдържа secret и съответства на
   read-only production диагностиката.
7. Изпрати неподдържана заявка и провери, че не е избран write инструмент.

Успех има само ако OAuth discovery, consent, tool selection и read резултатът
работят край до край с owner identity. Публичен `tools/list` или static bearer
проверка сами по себе си не са owner acceptance.

След нормален бъдещ deployment отвори съществуващата връзка, избери **Refresh**,
провери metadata и повтори read-only заявката в нов разговор. Не стартирай
deployment само за този тест и не ротирай OAuth secret.

## 2. GitHub — owner acceptance

### Read-only

1. Влез в SYNCHRON-X като owner и отвори **Връзки**.
2. Свържи разрешения GitHub профил през `/api/github/connect`.
3. Провери `/api/github/status`: връзката трябва да е owner-authorized.
4. В чата поискай read-only проверка на текущия `main` commit за
   `radostinvgeorgiev-commits/sunchron-backend`.
5. Сравни върнатия SHA с предварителната проверка.

Това са две отделни доказателства. `/api/github/status` проверява owner OAuth
сесията. GitHub read adapter-ът използва сървърния read достъп/публичния API, а
не owner OAuth сесията; неговият успешен SHA не трябва да се отчита като OAuth
tool call.

### Отрицателна контрола и отделен extended write acceptance

Production режимът без Copilot трябва да върне
`COPILOT_AUTOMATION_DISABLED`. Това е успешна отрицателна контрола: не трябва да
се създават issue, branch, commit или Pull Request.

Тази отрицателна контрола е валиден резултат за текущото owner acceptance и не
го оставя незавършено. Тя не доказва работещ GitHub write adapter. Реалният
GitHub write е отделен extended acceptance и не е условие за read-only
продуктовото приемане.

Не включвай Copilot automation само за acceptance. Реален GitHub write тест се
прави в отделна сесия едва когато има наличен Copilot достъп, изрично разрешена
production настройка и предварително одобрен test ресурс.

Преди точното потвърждение запиши:

- repository и base ref;
- пълния test prompt;
- очакваните issue, branch, Pull Request и неговото очаквано състояние;
- забрана за merge и deployment;
- кой и как ще затвори test issue/PR и ще премахне test branch.

SYNCHRON-X първо трябва да покаже подготвената задача и еднократното
потвърждение, включително ред `Задача: <пълния test prompt>`. Ако точният prompt
липсва, запиши `GITHUB_PROMPT_NOT_SHOWN` и не потвърждавай. Едва след копирано
точно потвърждение се проверява, че е създаден само описаният ресурс, Copilot е
реалният assignee и няма merge в `main`. Acceptance остава незавършен, докато
cleanup не е проверен.

## 3. Google — owner acceptance

### Read-only

1. Влез в SYNCHRON-X като owner и свържи Google през `/api/google/connect`.
2. Провери `/api/google/status`, без да записваш account данни в доказателството.
3. Изпълни по една read-only заявка за Calendar, Drive и Gmail.
4. Запиши само кой capability е извикан и дали е успял. Не записвай заглавия,
   участници, имена на файлове или съдържание на писма.

### Calendar write с точно потвърждение

Избери бъдещ свободен час и уникално заглавие без лични данни. Подготвящата
заявка е във формата:

```text
Създай събитие: SYNCHRON-X acceptance <run-id> | ГГГГ-ММ-ДД ЧЧ:ММ | 5 | | Изолиран acceptance тест; изтрий след проверката
```

Първият отговор трябва ясно да каже, че събитието още не е записано, да покаже
точните полета, включително target календара, и да върне еднократна фраза:

```text
Потвърждавам календарно събитие: <confirmation-id>
```

`prepareCalendarEvent()` обвързва потвърждението с `primary` calendar и трябва
да покаже `Календар: основен (primary)` в отговора. Ако редът липсва, запиши
`CALENDAR_TARGET_NOT_SHOWN`, не изпращай фразата и отчети Calendar write като
`blocked`.

Едва когато title, start, duration, timezone и target calendar са видими и
проверени, след отделното точно потвърждение:

1. провери, че е създадено точно едно събитие;
2. провери заглавието и времето през Google Calendar;
3. изтрий test събитието ръчно от Google Calendar;
4. провери, че събитието вече липсва.

SYNCHRON-X няма Calendar delete адаптер. Затова cleanup не се автоматизира и
write тестът не започва, ако owner няма достъп да изтрие събитието ръчно.

## Доказателство и резултат

За всяка секция запиши минимален ред без лични данни:

| Run ID | UTC | Production SHA | Provider | Read/write | Ресурс | Резултат | Cleanup |
| ------ | --- | -------------- | -------- | ---------- | ------ | -------- | ------- |

Допустими резултати: `passed`, `failed`, `blocked`, `not-run`. `blocked` не е
`passed`. При `COPILOT_AUTOMATION_DISABLED` запиши отделен ред
`GitHub / negative-control / passed`, а GitHub write — `not-run`. Не записвай
отрицателната контрола като работещ write adapter.

Текущият read-only owner acceptance е завършен само когато:

- ChatGPT MCP read работи с owner OAuth identity;
- GitHub owner OAuth status е connected, а отделният read adapter връща точния
  SHA, без двете проверки да се смесват;
- GitHub write отрицателната контрола е `passed`; реалният GitHub write остава
  отделен extended acceptance;
- Google read работи за Calendar, Drive и Gmail;
- няма неочаквано външно write действие.

Extended write acceptance се отчита отделно. Ако бъде стартиран, всеки GitHub
или Calendar write изисква видим точен target, еднократно потвърждение, проверка
на резултата и доказан cleanup. `blocked` или `not-run` в extended write не
обезсилва успешно завършения read-only owner acceptance.

При failure първо запиши provider, стъпка, безопасен error code и run ID. Не
прави несвързана архитектурна промяна и не публикувай tokens или response body с
лични данни.
