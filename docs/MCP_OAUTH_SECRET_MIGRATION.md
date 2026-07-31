# MCP OAuth secret migration

Тази процедура отделя ключа за OAuth кодове и токени от legacy статичния
`MCP_ACCESS_TOKEN`, без да прекъсва вече издадени OAuth сесии.

## Преди промяната

- `MCP_ACCESS_TOKEN` остава непроменен и продължава да защитава legacy MCP
  достъпа.
- OAuth кодовете, access tokens и refresh tokens се извеждат от същата тайна,
  но с отделни криптографски домейни.
- Не ротирай и не изтривай `MCP_ACCESS_TOKEN` в тази фаза.

## Фаза 1 — отделен OAuth ключ

1. Генерирай нова случайна стойност с поне 32 знака. Не използвай стойност от
   друга интеграция.
2. Добави я в production като secret environment variable
   `MCP_OAUTH_SECRET`.
3. Deploy-ни без промяна на `MCP_ACCESS_TOKEN`.
4. Провери `/health/ready`, production smoke и OAuth consent/token flow.
5. Провери refresh на OAuth сесия, създадена преди deployment-а.

След deployment-а новите authorization codes, access tokens и refresh tokens
се криптират с `MCP_OAUTH_SECRET`. Старите OAuth артефакти продължават да се
проверяват чрез legacy-derived ключа. Успешен refresh на стар token издава нови
токени с отделния ключ.

Невалидна непразна стойност под 32 знака спира OAuth fail-closed. Празна или
липсваща стойност запазва предишното поведение.

## Rollback на фаза 1

Ако има проблем непосредствено след deployment-а, върни предишния release и
премахни само `MCP_OAUTH_SECRET`. Не променяй `MCP_ACCESS_TOKEN`.

OAuth токени, издадени с отделния ключ, няма да работят след този rollback и
клиентът ще трябва да се свърже отново. Legacy токените остават валидни.

## Следваща отделна фаза

Премахването или ротацията на `MCP_ACCESS_TOKEN` не е част от тази промяна.
Направи го едва след доказан owner OAuth end-to-end тест, инвентар на legacy
потребителите и отделен rollback план. Това действие може да прекъсне реален
достъп и изисква изрично оперативно решение.

## Забрани

- Не използвай `MCP_OAUTH_SECRET` като bearer credential.
- Не записвай стойностите на двете тайни в логове, документация или issue.
- Не сменяй двете тайни едновременно.
- Не премахвай legacy fallback преди приключване на следващата миграционна
  фаза.
