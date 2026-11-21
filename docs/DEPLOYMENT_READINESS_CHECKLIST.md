# Deployment readiness checklist

Този checklist е за owner review преди merge/deploy към production.

## Среда и архитектура

- [ ] Canonical URL е `https://cloudaicore.com`.
- [ ] Runtime е Google Cloud Run.
- [ ] Паметта и operational state са във Firestore.
- [ ] Auth backend е Google Identity Platform.
- [ ] MCP endpoint е `https://cloudaicore.com/mcp`.

## AI и capabilities

- [ ] OpenAI Responses API е основният AI backend.
- [ ] Gemini, Grok, Claude и Codex са маркирани като допълнителни двигатели
      само при валидна конфигурация.
- [ ] Codex е в branch/PR write поток под owner confirmation.
- [ ] Няма write capability, която да заобикаля owner confirmation и audit.

## Безопасност

- [ ] Няма добавени secrets в diff-а.
- [ ] Няма промени по production secrets/IAM без изрично owner разрешение.
- [ ] Няма destructive операции (delete/drop/reset) без отделно потвърждение.
- [ ] Няма direct push към `main`.

## Проверки

- [ ] `npm test` минава за текущия branch.
- [ ] CI checks за PR са зелени.
- [ ] `/health` връща exact commit SHA след deployment.
- [ ] `/health/ready` е `ready`.
- [ ] `synchron/production-smoke` е success.

## Яснота в документацията

- [ ] Активните docs не представят `synchron.foundation`, OpenSearch или
      Supabase като текуща production истина.
- [ ] Legacy/архивните контексти са отделени в migration/archive документация.
- [ ] Ако нещо не е доказано, е отбелязано като недоказано, а не като факт.
