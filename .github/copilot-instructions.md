# SYNCHRON-X repository instructions

Read and follow `AGENTS.md` before changing anything. It is the authoritative
project workflow and safety policy.

## Project and commands

- This is a Node.js 22 / Express application. Use `npm ci` for dependencies.
- Run `npm test` before every proposed commit.
- Run `npm audit --omit=dev --audit-level=high` for production dependencies.
- Keep generated dependencies, virtual environments, logs and secrets out of
  Git. Never add `node_modules`, `venv`, `.env` files or token values.

## Change boundaries

- Work from the current `main` in a separate branch and open a Draft PR.
- Never push directly to `main`, merge your own PR or deploy production.
- Keep each task narrow. Preserve unrelated user changes and existing behavior.
- Do not modify personal memory, OpenSearch data, AI Core architecture,
  production secrets or paid resources unless the issue explicitly requires it.
- Treat GitHub, Google Cloud, Google Workspace and memory writes as external side effects.
  Keep the existing permission and confirmation boundaries.
- Never claim that an external action, assignment, check, merge or deployment
  happened without reading the real provider response.

## Code and verification

- Prefer the existing Tool Registry, Capability Engine, services and adapters;
  do not create a second execution path for the same capability.
- Fail closed for missing configuration, invalid identity or insufficient scope.
- Do not return or log tokens, passwords, secret values or personal data.
- Add focused regression tests for every behavior change and keep the full suite
  green.
- User-facing text is Bulgarian. Code identifiers may remain English.
- A task is not production-ready merely because local or PR tests pass. Report
  the exact unverified production step instead of asserting success.
