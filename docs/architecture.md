# Architecture and API

One Astro server renders the shell and serves a React workspace island. Thin routes call a small TypeScript service; the service owns validation and roles. The storage interface has local SQLite and AWS DynamoDB implementations with matching conditional-write and transaction semantics. No separate frontend/backend deployment is required.

```text
Astro pages + React editor
          │ same-origin /api
          ▼
authentication + origin check
          │
          ▼
KieliService: roles, validation, import, export
          │
          ▼
Store: SQLite locally / DynamoDB on AWS
```

## Source map

- `src/components/`: app shell, forms, project directory, developer integrations, importer.
- `src/server/auth.ts`: Okta flow, authorization, and export-token verification.
- `src/server/saml*.ts`: SAML configuration/credentials, shared replay cache, strict XML checks, signed login/metadata flow, signed Single Logout and shared session revocation fences.
- `src/server/local-auth.ts`, `passwords.ts`, and `account-api.ts`: built-in accounts, activation/reset, project assignments, throttling, and security events.
- `src/server/sessions.ts`: shared server-side sessions, cookie rotation, expiry, and revocation.
- `src/server/service.ts`: project/key operations, atomic counters, batched import, and exports.
- `src/server/store.ts`: storage adapters, conditional writes, transactions, filtered keyset pagination.
- `src/validation.ts`: shared schemas; server validation is authoritative.
- `src/lokalise.ts` and `src/workers/`: local import preview parsing.
- `src/pages/api/[...path].ts`: HTTP boundary, body limits, status codes, and routing.
- `cli/kieli.mjs`: portable Node-only translation pull.
- `infra/`: AWS SAM deployment.

## Storage and performance

The composite primary key is `(pk, sk)`:

| Entity                        | pk                                    | sk                   |
| ----------------------------- | ------------------------------------- | -------------------- |
| Project metadata              | `WORKSPACE`                           | `PROJECT#<id>`       |
| Translation key               | `PROJECT#<id>`                        | `KEY#<name>`         |
| Project aggregates            | `PROJECT#<id>`                        | `STATS`              |
| Hashed export token           | `PROJECT#<id>`                        | `TOKEN#<sha256>`     |
| Built-in user                 | `USERS`                               | `USER#<uuid>`        |
| Email uniqueness index        | `EMAIL#<sha256>`                      | `META`               |
| Hashed session identifier     | `SESSION#<sha256>`                    | `META`               |
| Hashed activation/reset token | `SETUP#<sha256>`                      | `META`               |
| Active admin counter          | `AUTH_CONTROL`                        | `ADMINS`             |
| Shared attempt bucket         | `AUTH_RATE#<sha256>`                  | `<time-window>`      |
| Security event                | `AUTH_AUDIT`                          | `<timestamp>#<uuid>` |
| Exact-source memory pointers | `PROJECT#<project>` | `TM#<source-hash>#<event-order>#<side>` |
| History index checkpoint | `PROJECT#<project>` | `TM_INDEX#<source-language>` |
| SAML request/assertion cache  | `SAML_CACHE#<scope-hash>`             | `<key-hash>`         |
| SAML logout flow / replay | `SAML_LOGOUT_FLOW#<scope-hash>#<relay-hash>` / `SAML_LOGOUT_REPLAY#<scope-hash>#<id-hash>` | `META` |
| SAML session revocation | `SAML_REVOKED#<issuer-subject-index-hash>` | `META` |
| SAML browser login flow       | `SAML_FLOW#<scope-hash>#<relay-hash>` | `META`               |

Keys and counters are written in one transaction with version conditions. Updating one key does not increment project settings' version. Aggregate coverage groups record how many keys share a set of filled locales, so adding a language updates completion immediately without rewriting every key. Per-language and namespace counts are also aggregated.

The workspace loads accessible project metadata once; the directory renders 40 rows per page, and the sidebar renders at most 30 matching entries. It does not load key collections for other projects. The editor fetches 25–100 keys at a time and resets selection on a new page/filter. Search is debounced and executed on the server. SQLite uses the composite primary index and JSON predicates; DynamoDB queries the project partition and applies search/locale predicates. The DynamoDB implementation follows evaluated pages until it fills a result page or reaches the end.

Substring search still evaluates matching project records on the backend; this is not a full-text search engine. Very large projects or many unique locale-coverage/namespace combinations may need a search index and sharded counters. The current single stats record shares DynamoDB's 400 KB item limit and is a write-contention point; conditional retries protect correctness but do not remove throughput limits. Imports are intended for small-to-medium teams and should be load tested against representative data before increasing the API's throttles.

## HTTP API

Data API endpoints require a browser session, except the explicitly public sign-in/activation/first-run setup endpoints. Only the export API also accepts `Authorization: Bearer <Kieli export token>`. The separate `/mcp` route requires a dedicated scoped MCP bearer credential and never accepts cookies. Browser mutation requests require an exact matching `Origin`, JSON content type, and a JSON body of at most 256 KB. Successful deletes return 204.

In SAML mode, GET `/auth/login` starts a signed request, GET `/auth/saml/metadata` publishes signed public metadata, and POST `/auth/saml/acs` accepts the bounded form-encoded IdP response. This active POST callback enforces signatures, browser binding, correlation, and atomic replay prevention instead of Origin. Optional GET/POST `/auth/saml/logout` authenticates signed SAML logout messages; app-initiated responses also require one-time browser/request binding. POST `/auth/logout?saml=1` checks Origin and revokes local access before redirecting to the configured IdP. See [SAML setup](saml.md). MCP permits an absent Origin for machine clients, rejects foreign Origins when supplied, and validates Host against `APP_ORIGIN`. All other browser writes retain exact-origin checks.

| Method    | Path                                                                         | Purpose                                                                |
| --------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| GET       | `/api/health`                                                                | Public health check                                                    |
| POST      | `/api/auth/install` | Complete explicitly enabled, AWS-secret-protected first-admin setup |
| POST      | `/api/auth/login`                                                            | Built-in email/password sign-in (public, origin-checked, rate-limited) |
| POST      | `/api/auth/activate`                                                         | Consume a one-time activation/reset link (public, origin-checked)      |
| POST      | `/api/auth/password`                                                         | Change own password and rotate session                                 |
| GET/POST  | `/api/users`                                                                 | Workspace admin lists/invites built-in users                           |
| PATCH     | `/api/users/:uuid`                                                           | Update roles/status with version checking                              |
| POST      | `/api/users/:uuid/link`                                                      | Issue activation/reset link                                            |
| POST      | `/api/users/:uuid/revoke`                                                    | Revoke all of a local user's sessions                                  |
| GET       | `/api/users/audit`                                                           | Workspace admin reads paginated security events                        |
| GET       | `/api/bootstrap`                                                             | Identity and accessible project metadata                               |
| POST      | `/api/projects`                                                              | Admin creates a project                                                |
| GET/PATCH | `/api/projects/:id`                                                          | Read/update project settings                                           |
| GET       | `/api/projects/:id/keys?limit=50&cursor=…&q=…&status=missing&namespace=home` | Filtered key page and project totals                                   |
| POST      | `/api/projects/:id/keys`                                                     | Create a key                                                           |
| PATCH     | `/api/projects/:id/keys/:name`                                               | Update translations/metadata with `version`                            |
| DELETE    | `/api/projects/:id/keys/:name?version=1`                                     | Delete a key with version condition                                    |
| GET       | `/api/projects/:id/summary`                                                  | Aggregated project counts                                              |
| GET/POST  | `/api/projects/:id/tokens`                                                   | List metadata/create export token                                      |
| DELETE    | `/api/projects/:id/tokens/:hash`                                             | Revoke export token                                                    |
| GET       | `/api/projects/:id/export?languages=en,fr&format=nested&fallback=true`       | Export translations                                                    |
| POST      | `/api/imports/lokalise/start`                                                | Start/retry creation of a new import project                           |
| POST      | `/api/projects/:id/import`                                                   | Import up to 20 validated keys; requires matching import/user          |

Key-page response: `{ items: [...], nextCursor?: "...", stats: {...} }`. Cursors are opaque, project-scoped positions, not stable snapshots: concurrent key insertions/deletions can alter later pages. Export returns `{ project, format, translations: { en: {...}, fr: {...} } }`; the browser download drops the metadata wrapper. Empty translations are `""` unless source fallback is enabled. Interpolation and ICU strings are preserved as entered. Nested export rejects collisions such as `a` and `a.b` with HTTP 422; flat export supports both.

Conflicting writes return 409, validation failures 400, authentication failures 401, and forbidden actions 403. Locale removal and source-language changes are intentionally unsupported after project creation to prevent silent data loss. New locales may be added. Key renaming is not yet supported; create the replacement key and coordinate consumer changes explicitly.

## Extension points

The Claude Code MCP adapter uses the official SDK's stateless Web Standards Streamable HTTP transport, with JSON responses and one server per request. Four tools call the same service; model-visible schemas are bounded, and write authorization/validation/concurrency remain inside `setMcpTranslations`. Dedicated credentials are stored under `PROJECT#<id> / MCP_TOKEN#<sha256>` with TTL. Translation success events commit atomically alongside keys/counters. Managers create/list/revoke credentials through `/api/projects/:id/mcp-tokens` and `/api/projects/:id/mcp-tokens/:hash`. Read-only export credentials cannot authorize MCP writes. See [MCP connection](mcp.md) for scopes, lifecycle, and setup.

Built-in account details and security boundaries are documented in [built-in accounts](built-in-accounts.md). Account-management endpoints are unavailable in Okta/demo mode; operator bootstrap/recovery exists in the CLI; the optional AWS installer initializes the first admin through the secret-protected web flow documented in [AWS guided installation](aws-one-click.md). Expired session/link/rate records carry a top-level `ttl` on DynamoDB and are still rejected synchronously even before eventual TTL cleanup.

## Deployment options

The [Terraform example](../infra/terraform/README.md) installs the existing Lambda ZIP stack without Docker. It manages a CloudFormation stack rather than duplicating individual infrastructure resources. [Further backend Lambda separation](lambda-backend-plan.md) is a plan only.
