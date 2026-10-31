# Keylo

A small, open-source home for product copy, keys, and manual translations. Astro frontend, TypeScript backend, built-in accounts, Okta OIDC or SAML SSO, and localization-file exports for apps and CI. MIT licensed.

No review workflows, screenshots, or built-in automatic translation. An optional Claude Code MCP connection lets you request translations using your own Claude client.

## Run locally

Requires Node.js 24.2 or newer. No Docker, AWS, or Okta account is needed for the local demo.

```sh
npm ci
npm run seed       # optional: 3 sample projects and 18 keys
npm run dev
```

Open the printed local URL (normally http://127.0.0.1:4321). SQLite data persists in `.data/keylo.sqlite`. Without the seed, start with an empty workspace. `.env.example` documents configuration; copy it to `.env` if needed. The demo identity has workspace admin access and is restricted to loopback outside production.

```sh
npm run check
npm test
npm run build
npm run smoke     # compiled HTTP server + real CLI, disposable local database
npm run smoke:local # compiled local-account lifecycle + operator CLI
npm run smoke:saml  # signed SAML HTTP round trip with disposable IdP fixtures (OpenSSL required)
npm run smoke:mcp   # official MCP client against the compiled HTTP endpoint
npm run smoke:install # extracted AWS ZIP + protected first-run setup
```

## Built-in users, without Okta

Set `AUTH_MODE=local` in `.env`, set `APP_ORIGIN` to your local URL, then initialize the first administrator:

```sh
npm run users:bootstrap -- --email admin@example.com --name "Workspace admin"
```

Open the one-time activation link printed by the command and choose a password. Workspace admins get **People & access** to create users, assign project roles, disable accounts, issue activation/reset links, and revoke sessions. Users can update their own password under **Your account**. No email provider or Okta account is required. [Built-in account setup and recovery](docs/built-in-accounts.md).

For the AWS install-button distribution, the stack generates a protected setup secret and opens a first-run administrator form instead of requiring the bootstrap CLI. The release packager, CloudFormation template generator, and optional publishing workflow are implemented. **A release AWS account/bucket is not configured yet, so no live install button is published.** See [AWS guided installation and release publishing](docs/aws-one-click.md).

Production requires an HTTPS `APP_ORIGIN` and an explicit `AUTH_MODE=local`, `okta` (OIDC), or `saml`. For OIDC, configure the issuer, client credentials, and a 64-character hex `SESSION_SECRET` for the login-state cookie. For SAML, configure the trusted IdP issuer/SSO URL and signing certificates as described in [SAML setup](docs/saml.md). `NODE_ENV=production` **rejects demo authentication**. The Docker image and SAM template default to built-in accounts and set production mode explicitly.

## What works

- Separate projects with a source language and up to 30 configured languages; custom BCP 47 locales supported.
- Dense project directory and searchable, scrollable navigation for hundreds of projects.
- Auto/light/dark appearance, saved per browser and shared across tabs. Auto follows system changes; the theme is applied before the page paints.
- Server-side keyset pagination (25, 50, or 100 rows), debounced search across names/copy/context/tags, namespaces, and missing-translation filters.
- Multi-language key editor with source copy, context, tags, and optimistic concurrency control.
- Transactional project counters: reads of a key page do not fetch all translations to calculate progress.
- Lokalise JSON ZIP and API-snapshot import with local preview, validation, explicit conversion warnings, and retryable atomic batches.
- Optional built-in email/password accounts with Argon2id hashing, admin-issued activation/reset links, project-role assignments, account disabling, shared login throttling, and security events.
- Okta OIDC Authorization Code + PKCE as an alternative, with revocable server-side sessions, opaque HttpOnly cookies, and project-scoped admin/manager/user permissions.
- SAML 2.0 SP-initiated SSO, signed requests/metadata, pinned IdP certificates, signed responses/assertions, shared replay prevention, and stable issuer/subject identities. All auth modes keep roles server-side.
- Expiring, revocable, read-only export tokens stored only as SHA-256 hashes.
- Claude Code MCP: project/target-language-scoped credentials, bounded context tools, versioned atomic translation batches, overwrite opt-in, usage visibility, and security events.
- Keyed file imports and exports: JSON, YAML, JavaScript/TypeScript, PHP arrays, properties, INI, RESX, keyed PO/POT, Apple strings/plist, Android XML, ARB, XLIFF 1.2 and CSV. ZIP downloads, optional source fallback, and a zero-dependency Node CLI. [Exact format support and limits](docs/file-formats.md).
- One container and an AWS SAM template for Lambda, HTTP API Gateway, and DynamoDB. No VPC, NAT gateway, database server, or background worker.
- A separate prebuilt AWS ZIP installer with automatic HTTPS origin, an AWS-secret-protected first-admin form, data retention, and versioned CloudFormation release/upgrade artifacts. Publishing is optional and unconfigured by default.

## Import from Lokalise

Choose **Admin → Import from Lokalise**. In Lokalise, download **JSON**, **one file per language**, with `%LANG_ISO%.json` filenames. Select all required languages, include all platform keys and untranslated strings, and keep missing values empty. Upload the downloaded ZIP, inspect the key/language counts and sample, choose the source language, then create the new project. For other keyed file formats, use **Admin → Import translation files**; [format support](docs/file-formats.md) describes the supported subsets.

Nested JSON becomes dotted keys. Existing projects and their translations are never overwritten. Each batch of up to 20 keys commits atomically with its counters; an interrupted project import can be retried in the same open dialog. Completed batches remain saved. Keep the dialog open until completion; a project import is not one large transaction.

API snapshots additionally preserve descriptions and tags. See [Lokalise import formats](docs/lokalise-import.md) for the snapshot shape, platform/plural handling, limits, and a sample fixture.

## Pull translations

Create an export token under the project's **Developers** tab. Save it in your shell environment or CI secret store as `KEYLO_TOKEN`.

```sh
node cli/keylo.mjs pull \
  --url https://copy.example.com \
  --project acme-website \
  --out ./src/locales \
  --languages en,fr,nl \
  --format nested
```

This writes `en.json`, `fr.json`, and `nl.json`. Omit `--languages` to export all languages. Add `--fallback` to fill missing translations from the source. Each locale file is replaced atomically; unrelated files are preserved. The CLI does not publish changes back to Keylo. Use `--demo` for local testing without a token.

Choose another format with, for example, `--format strings`, `--format yaml`, `--format android`, or `--format xliff`. The **Developers** tab generates CLI and cURL examples for the selected format. Interactive exports download a ZIP containing individual locale files.

Example CI build step (after checkout and Node setup):

```yaml
- name: Pull copy
  env:
    KEYLO_TOKEN: ${{ secrets.KEYLO_TOKEN }}
  run: node cli/keylo.mjs pull --url https://copy.example.com --project acme-website --out src/locales
- run: npm run build
```

The CLI file can be copied into a consuming repository; it uses Node built-ins only. Run it before the app build so an export failure stops the pipeline.

## Access and deployment

To connect Claude Code, open **Developers → Claude Code**, issue a credential for selected target languages, and copy the `.mcp.json` template into your consuming repository. Set `KEYLO_MCP_TOKEN` in the environment that launches Claude Code. Source copy and key metadata remain protected; existing translations require explicit overwrite permission. See [MCP connection and lifecycle](docs/mcp.md). Local-account credentials last up to 30 days; SSO credentials are capped at the issuing sign-in's absolute expiry, within one hour.

| Role                                       | Permissions                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------ |
| Workspace admin (`keylo-admin`)            | All projects, project creation, imports, keys, translations, settings, export tokens |
| Project admin (`keylo:<project-id>:admin`) | Full access within the assigned project                                              |
| Manager (`keylo:<project-id>:manager`)     | Project settings, key creation/deletion, all translations, export tokens             |
| User (`keylo:<project-id>:user`)           | Read project copy, edit target translations, interactive export                      |
| Export token                               | Only `GET /api/projects/<assigned-project>/export`                                   |
| MCP credential                             | Only `/mcp`: read assigned project context and save selected target translations     |

With built-in accounts, assign roles in **People & access**. Access edits and deactivation revoke previous sessions immediately; the last active local admin is protected. SSO uses a central issuer/subject directory with current permissions checked per authentication. Configure [SCIM provisioning and optional Okta reconciliation](docs/sso-lifecycle.md) for upstream offboarding and group synchronization. Admins can block/revoke access; users can sign out and revoke their personal connections. All modes use server-side sessions. Keylo sign-out does not end the IdP session; SAML Single Logout remains unsupported.

- [Built-in accounts](docs/built-in-accounts.md)
- [Okta setup](docs/okta.md)
- [SAML 2.0 setup](docs/saml.md)
- [Claude Code MCP](docs/mcp.md)
- [AWS deployment](docs/aws.md)
- [AWS install button and upgrades](docs/aws-one-click.md)
- [API and architecture](docs/architecture.md)
- [Security model and reporting](SECURITY.md)
- [Proposed self-hosted and SaaS model](docs/saas-model.md) (pricing/cost assumptions and required tenant architecture; not implemented)

The included local checks exercise roles, isolation, concurrency, import retries and validation, 1,100-key pagination/search, token expiry/revocation, CLI files, and JSON export safety, plus local account activation, password reset, session revocation, last-admin races, and role changes. SAML checks use signed disposable IdP fixtures to verify replay prevention, tampering, certificate trust, browser binding, strict recipients, expiry, and session rotation. A live Okta tenant, real DynamoDB/Secrets Manager, the Docker image, and the SAM deployment need integration verification in your AWS account; local tests are not a security audit.

Plural keys use Unicode cardinal/ordinal forms with project-level overrides. Linked copy uses `[%key:other.key%]` and resolves in previews, exports and published releases. See [message semantics and scale](docs/messages.md).

Managers can create/download/restore [project snapshots](docs/project-history.md), including daily/weekly automatic snapshots. Both AWS templates include the authenticated scheduler. [Live app delivery](docs/ota.md) publishes immutable preview/production releases with rollback and read-only app credentials. Swift, Kotlin and Flutter mobile [client SDK sources](sdks/README.md) are downloadable from Developers. No review workflow or automatic translation service is introduced.
