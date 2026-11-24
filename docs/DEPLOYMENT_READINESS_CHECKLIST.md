# Deployment readiness checklist

Този checklist се използва преди merge към `main` и преди production deployment.
Той не стартира deployment сам по себе си.

## 1. Source of truth

- Repository: `radostinvgeorgiev-commits/sunchron-backend`.
- Release branch: отделен branch, не директен commit към `main`.
- Canonical site: `https://cloudaicore.com`.
- Runtime: Cloud Run.
- Storage: Firestore за памет и operational state.
- Auth: Identity Platform.
- MCP endpoint: `https://cloudaicore.com/mcp`.
- AI providers: Claude е основен; OpenAI, Gemini и Grok са незадължителни
  съветници. Codex е изключен. Това описва кода, не непременно live revision.

## 2. Преди merge

- [ ] PR diff е прегледан.
- [ ] Няма secret стойности в diff-а.
- [ ] `npm test` минава.
- [ ] `git diff --check` минава.
- [ ] Няма промяна на production secrets.
- [ ] Поведението на production Cloud Build trigger-а е проверено; няма
      автоматичен deployment път, който заобикаля отделното owner confirmation.
- [ ] Собственикът е осигурил `ANTHROPIC_API_KEY` и е проверил
      `AI_CORE_PROVIDER` и правото на runtime identity да използва секрета.
- [ ] Няма direct push към `main`.
- [ ] Няма нов външен side effect без owner confirmation gate.
- [ ] Отворените PR-и са проверени за конфликт или дублиране.

## 3. Production health преди deployment

- [ ] `GET https://cloudaicore.com/health` връща `ok`.
- [ ] `/health` връща exact SHA, който съвпада с expected release commit.
- [ ] `GET https://cloudaicore.com/health/ready` връща `ready`.
- [ ] `GET https://cloudaicore.com/health/storage-report` показва healthy Firestore.
- [ ] Identity Platform health е healthy.
- [ ] MCP/OAuth endpoint е reachable.

## 4. Acceptance преди deployment

- [ ] Staging acceptance е минал за същия exact SHA; виж
      `STAGING_AND_RELEASE_GATES.md`.
- [ ] A1: стабилен owner разговор е проверен в browser.
- [ ] A2: memory lifecycle е проверен с тестов факт и отделни потвърждения.
- [ ] A3: неразрешено действие се отказва без външен side effect.
- [ ] A4: разрешено действие спира на confirmation gate, изпълнява се след точно
      потвърждение и audit read връща проверим запис.
- [ ] A5: staging fault injection доказва контролирана грешка и възстановяване.

## 5. След deployment

- [ ] `/health` връща новия exact SHA.
- [ ] `/health/ready` остава `ready`.
- [ ] `/health/storage-report` остава healthy.
- [ ] Production smoke е зелен.
- [ ] Browser smoke: сайтът зарежда, Claude отговаря и Council използва
      наличните съветници; при отказ на Claude показва грешка без fallback.
- [ ] Ако има проблем, използвай `OPERATIONS_RUNBOOK.md` за rollback.

## 6. Блокиращи условия

Deployment не се прави, ако има поне едно от следните:

- exact SHA не съвпада;
- health или ready не минава;
- storage-report не е healthy;
- има failing CI;
- има secret в diff-а;
- A4 audit read остава непроверен;
- A5 recovery остава само локално проверен;
- owner не е дал отделно потвърждение за merge/deploy.

## 7. Яснота в документацията

- [ ] Активните docs не представят `synchron.foundation`, OpenSearch или
      Supabase като текуща production истина.
- [ ] Legacy/архивните контексти са отделени в migration/archive документация.
- [ ] Ако нещо не е доказано, е отбелязано като недоказано, а не като факт.
