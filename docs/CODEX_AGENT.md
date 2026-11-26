# Codex агент в AI CORE

Codex е основният code/ops изпълнител в AI CORE, но винаги под owner control.
Той работи в стандартния защитен поток:

`read → branch → write → commit → PR → tests → owner review → merge/deploy само след потвърждение`.

## Разрешен обхват

Codex може:

- да чете repository, docs, тестове, issues, PR-и и deployment конфигурация;
- да анализира кода и текущата среда;
- да създава отделен branch;
- да подготвя code diff, да прави commit и да отваря Pull Request;
- да добавя/поправя тестове и да обновява свързаната документация;
- да подготвя deployment checklist без да стартира deploy самостоятелно.

## Ограничения и контрол

Следните действия са блокирани без отделно изрично owner потвърждение:

- direct push към `main`;
- merge към `main`;
- production deployment;
- промяна на secrets, IAM или permissions;
- destructive storage/database действия;
- външни write действия извън разрешения scope.

Всички рискови действия минават през capability gate, точна confirmation
стъпка и audit запис.

## Engine и capability правила

- Codex и Claude не се считат за „активни“ само по UI индикатор.
- Всеки engine минава конфигурационна проверка, capability validation и
  acceptance тест.
- При липса на валидна конфигурация заявката fail-ва честно и не се представя
  като успешна.

## Практически acceptance

Codex е приеман за operational, когато:

1. генерира ограничен и прегледим diff в отделен branch;
2. пуска релевантните тестове за промяната;
3. отваря PR с ясен risk и validation отчет;
4. спира преди merge/deploy и изчаква owner confirmation.
