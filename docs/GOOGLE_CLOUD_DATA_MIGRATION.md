# Google Cloud data migration

Крайната production среда е само Google Cloud:

- Cloud Run вместо DigitalOcean App Platform;
- Firestore вместо OpenSearch;
- Identity Platform вместо Supabase Auth;
- Secret Manager вместо runtime secrets в DigitalOcean;
- Google Load Balancer, Cloud Armor и Cloud DNS вместо Cloudflare.

OpenSearch и Supabase са само временни източници за еднократното прехвърляне.
Те не са резервен runtime и се премахват след доказаното cutover.

## Безопасен ред

1. `inventory` чете само наличност и брой документи. Не връща съдържание.
2. Identity Platform user import създава точна Supabase → Identity map.
3. `plan` прочита snapshot-а, валидира схемите и връща SHA-256 confirmation.
4. `apply` приема само точното confirmation за непроменения snapshot.
5. Всеки запис във Firestore се прочита обратно и сравнява преди успех.
6. Изпълняват се user, memory, workspace, OAuth и restore acceptance тестове.
7. Едва след това се прави Google edge cutover.
8. Старите услуги и адаптери се премахват след изрично потвърждение.

## Команди

Само inventory:

```bash
npm run gcp:migrate:inventory
```

План с private identity map извън Git:

```bash
node scripts/migrateOpenSearchToFirestore.js \
  --plan \
  --identity-map /secure/path/users.migration-map.json
```

Записът се изпълнява само в еднократен Cloud Run Job със service identity и
фиксирани Secret Manager версии:

```bash
node scripts/migrateOpenSearchToFirestore.js \
  --apply \
  --identity-map /secure/path/users.migration-map.json \
  --confirmation MIGRATE_OPENSEARCH_TO_FIRESTORE:<exact-plan-sha256>
```

Не се използват `latest` secret версии. Identity map, source credentials,
документи, OAuth tokens и лична памет не се показват в stdout и не се commit-ват.

## Трансформации

- member owner namespace: `supabase:<old-id>` →
  `identity-platform:<new-id>`;
- profile/workspace/task ключовете се преизчисляват за новия owner;
- tester approvals се свързват с новия Identity Platform user;
- GitHub/Google OAuth документите получават Firestore provider marker;
- audit документите получават Firestore partition marker;
- pending confirmations не се пренасят, защото са обвързани със стара сесия;
- email approval hashes не се пренасят, защото са обвързани със стар secret;
- MCP grants и replay защитата се пренасят и проверяват.

Cloud Run Jobs поддържа private service identity, фиксирани secrets, един task и
нула retry опити за контролиран migration run: [Create jobs](https://cloud.google.com/run/docs/create-jobs),
[Configure secrets for jobs](https://cloud.google.com/run/docs/configuring/jobs/secrets).
