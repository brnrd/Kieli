# Working in this repository

Read [COLLABORATING.md](COLLABORATING.md) for contributor guidance and [README.md](README.md) for current behavior. These instructions apply throughout the repository.

## Scope and architecture

- Preserve the small self-hosted product: one organizational workspace, separate projects, Astro with a React editor, a TypeScript backend, SQLite locally and DynamoDB on AWS.
- Keep business rules and authorization in backend services. Routes should remain thin; browser validation is supplementary.
- No translation-review/approval workflow, screenshot feature, built-in automatic translation service or SaaS tenancy unless the user explicitly changes that scope. User-requested Claude MCP translation is supported.
- Prefer existing modules and deployment components. Add infrastructure or dependencies only when necessary to solve the concrete problem.

## Data and security

- Preserve equivalent SQLite/DynamoDB behavior. Use conditional writes and atomic transactions for related records, counters and authorization checks; test relevant races.
- Preserve stored copy and history. Document migrations, compatibility implications and recovery for persisted-data changes.
- Keep local, OIDC and SAML identities separate. Use immutable issuer/subject identity; never link accounts by email.
- Keep export, MCP, provisioning and maintenance credentials confined to their intended endpoints/scopes. Enforce roles on the server.
- Never execute imported files or render translation text as trusted markup. Reject unsupported format structures instead of silently losing data.
- Use synthetic fixtures and disposable databases. Do not modify `.data/`, real projects, credentials or cloud resources for tests.
- Never commit secrets, customer copy, generated build artifacts or native SDK build output. Preserve existing security documentation's distinction between local checks and live integration verification.

## Implementation and verification

- Search with `rg`; read the relevant implementation and documentation before editing. Preserve unrelated user changes and keep commits focused.
- For application changes, run `npm run check`, `npm test` and `npm run build`, then the affected HTTP smoke checks listed in COLLABORATING.md. Add regression tests for meaningful behavior and authorization/concurrency changes.
- For visible UI changes, inspect the rendered result in a browser. Keep layouts compact, accessible and usable with many languages and keys.
- For infrastructure changes, render/lint affected templates and check scoped IAM and optional configuration. Do not deploy or publish merely to validate a patch.
- For SDK changes, run the relevant native checks in sdks/README.md. For documentation/template-only changes, validate links/examples and YAML/Markdown structure plus `git diff --check`; no application test run is required.
- Update documentation with changed behavior and limitations. Report what passed and what could not be verified; do not claim a live Okta/AWS test from a local fixture.
