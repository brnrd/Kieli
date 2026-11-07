# Collaborating on Kieli

Kieli is an MIT-licensed, self-hosted home for product copy and translations. Contributions should make its everyday localization workflow useful while keeping the interface purposeful, the backend small, and deployment straightforward.

## Product scope

- One organizational workspace with separate projects, source and target languages, and server-enforced roles.
- Built-in accounts, Okta OIDC or SAML; SQLite locally and DynamoDB on AWS.
- Manual translation, localization files, CLI/CI integration, and explicit publication of mobile translation releases.
- An optional MCP connection lets a user's Claude client translate when requested. Kieli does not run a built-in automatic translation service.

Screenshots, translation-review/approval workflows and a multi-tenant SaaS product are outside the current scope. Discuss changes to these boundaries before building them. Security audit events and translation freshness are part of the product; they do not introduce a review workflow.

## Getting started

Use Node.js 24.2 or later:

```sh
npm ci
npm run seed # optional sample projects; use a disposable local database
npm run dev
```

The [README](README.md) covers local accounts, authentication, import/export and deployment. [Architecture](docs/architecture.md), [message semantics](docs/messages.md), [supported file formats](docs/file-formats.md) and the [security policy](SECURITY.md) describe implementation boundaries. `.env.example` lists configuration; never commit a populated `.env`.

## Issues and proposals

Use the bug report form for reproducible failures and the feature form for a concrete user problem. Include the affected version or commit and a small example with synthetic copy. Check existing issues before filing a duplicate.

For a feature, describe who needs it, the expected behavior, and a small first version. Discuss changes to storage, authentication, formats or deployment before a large implementation. A proposal does not need to match every feature in another translation platform.

Report security vulnerabilities through the process in [SECURITY.md](SECURITY.md), not a public bug report. Omit credentials, assertions, customer translations and personal data from reports, logs and attachments.

## Making a change

1. Start from the current default branch and use a branch for your contribution.
2. Keep the change focused. Prefer small modules and shared service logic over new infrastructure or duplicated endpoint rules.
3. Add meaningful regression coverage for behavior changes. Use disposable data and local identity-provider fixtures; never depend on a contributor's AWS or Okta account.
4. Update relevant documentation and examples when behavior, configuration, API contracts or supported formats change.
5. Open a pull request explaining the problem, resulting behavior and verification. Call out migrations, compatibility changes and remaining limitations.

Keep unrelated formatting and dependency updates in separate changes. Preserve other contributors' work. Changes should be reviewable in logical commits; publishing artifacts or deploying a stack is a separate action from preparing a PR.

## Validation

For application changes, run:

```sh
npm run check
npm test
npm run build
```

After building, run the HTTP smoke checks affected by your change:

| Area                                    | Check                    |
| --------------------------------------- | ------------------------ |
| Core API, export and CLI                | `npm run smoke`          |
| Key renaming and reference updates      | `npm run smoke:rename`   |
| Bulk tag and namespace changes          | `npm run smoke:bulk`      |
| Target language disable/enable          | `npm run smoke:languages` |
| Project archiving and read-only access  | `npm run smoke:archive`  |
| Apple native localization files        | `npm run smoke:apple`    |
| Messages, snapshots and delivery        | `npm run smoke:features` |
| Previous translations and history index | `npm run smoke:memory` |
| Project glossary and term exchange      | `npm run smoke:glossary` |
| Built-in accounts                       | `npm run smoke:local`    |
| SAML authentication                     | `npm run smoke:saml`     |
| SCIM and SSO lifecycle                  | `npm run smoke:sso`      |
| Source-sync CLI and credentials         | `npm run smoke:sync`     |
| MCP protocol and credentials            | `npm run smoke:mcp`      |
| AWS install package and first-run setup | `npm run smoke:install`  |

SAML fixtures require OpenSSL. Infrastructure changes should also render and lint the relevant CloudFormation templates; see the [CI workflow](.github/workflows/ci.yml) for exact commands. For SDK behavior changes, run the affected native SDK checks documented in [sdks/README.md](sdks/README.md). Dependency/security work should include the applicable dependency audit.

Inspect visible UI changes in the browser, including narrow layouts and both themes when affected. For documentation/templates alone, check paths, examples, YAML/Markdown structure and `git diff --check`; application tests are not required unless runtime behavior changes.

CI runs broader release checks. Passing local fixtures does not establish production readiness: real IdP mappings, AWS permissions, workload limits and restoration procedures need staging verification.

## Design and compatibility

Keep business rules in the backend service layer. Routes handle HTTP boundaries; the browser may offer previews but cannot authorize a write. Preserve equivalent conditional-write and transaction behavior in SQLite and DynamoDB, including counters and concurrent edits.

File adapters must reject unsupported structures rather than silently discard meaningful data. Never execute imported content. Treat translations and MCP-visible copy as untrusted text. Avoid introducing a background worker, search service or extra deployment dependency without a demonstrated need.

Use direct, task-focused interface labels such as “Edit key” and “Export translations.” Keep promotional slogans out of the workspace, dialogs and sign-in pages. Put field helper text after its control so adjacent inputs stay aligned; keep short optional markers on the label line. Favor compact layouts for people editing copy for extended sessions.

Changes to persisted data need a documented, repeatable migration and a recovery strategy. Preserve existing data and API compatibility where practical, and state limitations honestly. Use plain labels and compact layouts that remain usable with many projects, keys and languages.

## Licensing

Contributions are provided under the repository's [MIT license](LICENSE). Do not include code, assets or datasets without compatible redistribution rights; retain required third-party notices.
