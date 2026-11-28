---
name: pusni-promyana
description: Implement a requested NovariumAI change in an isolated branch, validate it, and open a Draft pull request. Use for code changes and maintenance tasks in this repository.
---

# Пусни промяна

1. Прочети `AGENTS.md`, `docs/MANIFESTO.md`, `docs/CONTEXT.md` и
   `.github/copilot-instructions.md`.
2. Провери работното дърво и latest `origin/main`. Не стъпвай върху чужди или
   непубликувани промени; направи отделен клон от `main` за тази задача.
3. Изпълни само исканата промяна. Не променяй production, Google Cloud,
   secrets, IAM или лични данни.
4. Добави целеви тестове и изпълни `npm test` и `git diff --check`.
5. Отвори Draft PR към `main` и опиши реално промененото и непровереното.
   Не merge-вай и не deploy-вай.

Ако нещо е блокирано от права, липсващи данни или небезопасна production
проверка, спри точно на тази граница и посочи какво липсва.
