# Staging and production release gates

This document defines the intended release path. It does not configure Google
Cloud, deploy a revision, or prove that staging or the Cloud Build trigger is
currently configured.

## What exists today

- `deploy/cloud-run/staging.config.example.json` is a placeholder example, not
  verified live configuration.
- `scripts/renderCloudRunStaging.js` renders a staging manifest from a complete
  configuration. `scripts/verifyCloudRunStaging.js` checks an already-running
  staging service. Neither script deploys the service.
- The production runbook describes the owner-confirmed
  `synchron-main-deploy` Cloud Build trigger. Its connection to GitHub and its
  trigger settings have not been verified.
- There is no GitHub Actions staging deployment or production deployment
  workflow. GitHub Environment approvals therefore do not currently gate
  Cloud Build.

## Intended release sequence

1. A pull request passes the repository's Node.js checks.
2. The owner deploys the exact candidate commit to an isolated staging service
   using an explicitly authorized deployment path.
3. Staging checks pass for the same full commit SHA, including the automated
   verifier and browser registration/login acceptance with a dedicated test
   account.
4. The owner reviews and merges the pull request.
5. Before any production deployment, the owner verifies that the production
   Cloud Build trigger is configured for the intended repository, branch and
   exact commit SHA, and cannot deploy automatically around the confirmation
   step.
6. The owner prepares and separately confirms the exact-SHA Cloud Build action
   using the procedure in `OPERATIONS_RUNBOOK.md`.
7. The production smoke check passes for the deployed exact SHA.

Passing CI or staging is not authorization to deploy production. Do not merge
or deploy while a required check is blocked or the trigger's behavior is
unknown.

## Owner setup checklist for staging

- [ ] Confirm the non-production Google Cloud project and the
      `synchron-backend-staging` service are approved and isolated from
      production data.
- [ ] Configure a dedicated staging runtime service account with only the
      required staging permissions.
- [ ] Configure staging Firestore and Identity Platform resources; do not
      point staging at production user or memory data.
- [ ] Use an immutable Artifact Registry image digest and the exact 40-character
      commit SHA.
- [ ] Complete a private staging configuration based on
      `deploy/cloud-run/staging.config.example.json`. Keep it out of Git.
- [ ] Set every staging Secret Manager reference to a fixed numeric version.
      Use staging secrets only; never put secret values in repository files,
      workflow logs, or this checklist.
- [ ] Verify Cloud Run IAM has no public invoker, and verify the ingress and
      access design before accepting authenticated staging checks.
- [ ] Deploy only after the owner has reviewed the exact target project,
      service, image digest and commit SHA.
- [ ] Run `scripts/verifyCloudRunStaging.js` against that already-deployed
      service and confirm its reported commit matches the candidate SHA.
- [ ] Complete browser acceptance using a dedicated staging test account,
      including registration, email verification, login and cleanup.
- [ ] Record results and any remaining blockers in the pull request. Never use
      a real customer's account for acceptance.

The verifier requires an authenticated `gcloud` identity and checks the
existing service configuration, private IAM policy, immutable image, exact
commit, health/readiness and Identity Platform readiness. It is an acceptance
check, not a deployment command.

## Production confirmation boundary

The repository's documented production route is the owner-confirmed
`synchron-main-deploy` Cloud Build trigger, not a GitHub Actions deployment.
Before relying on it, the owner must inspect the live trigger and verify that
no push trigger or other independent path can publish to production without
the owner's separate confirmation. This repository change does not alter that
trigger or its IAM.

Use the exact-SHA prepare/confirm procedure in `OPERATIONS_RUNBOOK.md`; review
the target and SHA before confirmation. Afterward, require the exact-SHA
production smoke check and browser acceptance. If any gate fails, stop and use
the rollback procedure in the operations runbook; do not retry against a
different SHA without a new review.
