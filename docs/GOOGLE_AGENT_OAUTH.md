# Отделен Google агент към NovariumAI

Това е OAuth връзка за Gemini CLI/Antigravity, а не добавяне на функции към
обикновения Gemini чат. Не изключва ChatGPT, не сменя AI доставчика на сървъра
и не споделя неговите токени. Поддръжката е изключена по подразбиране.

## Регистрация на точния клиент

След преглед и deployment операторът задава **несекретната** runtime променлива
`MCP_GOOGLE_OAUTH_CLIENTS`. Пример с минимални права:

```json
[
  {
    "client_id": "synchron-gemini-cli",
    "client_name": "Gemini CLI",
    "redirect_uris": ["http://127.0.0.1:7777/oauth/callback"],
    "scope": "synchron:read offline_access"
  }
]
```

Поддържат се само `synchron-gemini-cli` и `synchron-antigravity`, с отделен
запис за всеки клиент. Callback адресите се сравняват точно. Не се поддържат
wildcard, динамична регистрация, тайна в client ID или произволно теглене на
client metadata. HTTPS callback трябва да завършва с `/oauth/callback`, без
query/fragment/credentials; HTTP е разрешен само за loopback с конкретен порт.

Записите не дават сами достъп. Потребителят влиза в NovariumAI и одобрява точно
показаните scopes. За Google данни и GitHub/инфраструктурни записи се изисква
owner, както досега. Всяко чувствително действие запазва отделното потвърждение.
Регистрацията трябва да разрешава само действително нужните scopes; добавяй
write scopes след преглед на конкретните действия, не автоматично.

## Настройка на Gemini CLI

Обедини този запис с наличния `mcpServers` в настройките на работния проект.
Не презаписвай целия `~/.gemini/settings.json` и не добавяй Bearer токен на ChatGPT.

```json
{
  "mcpServers": {
    "novarium": {
      "httpUrl": "https://cloudaicore.com/mcp",
      "trust": false,
      "oauth": {
        "enabled": true,
        "clientId": "synchron-gemini-cli",
        "authorizationUrl": "https://cloudaicore.com/oauth/authorize",
        "tokenUrl": "https://cloudaicore.com/oauth/token",
        "issuer": "https://cloudaicore.com",
        "authorizationResponseIssParameterSupported": false,
        "redirectUri": "http://127.0.0.1:7777/oauth/callback",
        "scopes": ["synchron:read", "offline_access"]
      }
    }
  }
}
```

Стартирай вече конфигурирания Google агент, след това `/mcp auth novarium`.
Loopback callback работи само когато браузърът и CLI са на една машина.
В Cloud Shell/SSH браузърът на компютъра не може да достигне remote `127.0.0.1`:
нужен е отделен проверен callback маршрут или локално SSH port forwarding.
Не замествай redirect URI с непроверен адрес и не публикувай OAuth кодове.
При Antigravity първо провери поддържаните OAuth client/redirect настройки;
Gemini CLI конфигурацията не е доказателство за Antigravity end-to-end.

## Проверки преди приемане

1. `Connected` и `tools/list` доказват само discovery. Runtime статусът е публичен.
2. Защитен инструмент без токен трябва да върне 401.
3. След реален вход извикай един разрешен read инструмент от Google агента.
4. Провери отново същия инструмент през съществуващия ChatGPT конектор.
5. Отнеми само Google grant-а в NovariumAI → Разрешения и докажи, че ChatGPT остава активен.
6. Запис тествай само с отделно точно owner потвърждение.

Успешните локални OAuth тестове не доказват реален Google агент или production
deployment. Ако Gemini върне quota/503, отчети теста като блокиран. Платеният
Gemini абонамент не е доказателство за достатъчна квота на API ключа.
