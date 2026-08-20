# Owner acceptance

Acceptance се изпълнява ръчно от owner с реална сесия. Не стартирай write
acceptance от CI.

## Read-only

1. Отвори `https://cloudaicore.com` и потвърди owner профила.
2. Поискай `get_system_configuration` и
   `get_google_cloud_runtime_status`.
3. Провери GitHub repository overview, Drive и Calendar read.
4. Свържи ChatGPT към `https://cloudaicore.com/mcp` и провери видимите scopes.

## Потвърден кодов write

1. Задай малка UI задача с изискване за тест.
2. Провери, че се показват OpenAI, Gemini, Grok и coding ролята.
3. Провери точните файлове и че няма secrets или deployment конфигурация.
4. Въведи единствено показаната фраза
   `Потвърждавам AI CORE кодова задача: <uuid>`.
5. Провери branch, commit, Pull Request и CI; `main` не трябва да е променен
   директно.

## Други writes

Използвай общия цикъл: prepare → преглед на въздействието → точно
потвърждение → execute → verify. Календарът използва
`Потвърждавам календарно събитие: <uuid>`. Не приемай задача, ако целта,
профилът или конкретната промяна не са показани.

Не копирай Authorization headers, token-и или secret стойности в отчета.
