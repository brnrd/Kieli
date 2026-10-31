# Claude Code connection

Keylo serves MCP over Streamable HTTP at `/mcp`. Claude Code reads project context and saves translations when you ask it to. Keylo does not call an AI provider, run translation jobs, or require an Anthropic API key. Your Claude client handles generation; copy read through the tools is shared with that client/provider.

## Connect

1. Open a project's **Developers → Claude Code** section as a project manager or administrator.
2. Choose the allowed target languages, a connection name, and expiry. Keep **Allow replacing existing target translations** off to fill missing translations only.
3. Create the credential and copy it immediately; the full value is shown once. Store it in a trusted secret manager. This is a personal connection tied to its creator, not a service account.
4. Merge the displayed configuration into `.mcp.json` in the consuming code repository. Set its URL to your Keylo origin plus `/mcp`. The example in [`.mcp.json.example`](../.mcp.json.example) uses an environment variable, not a literal secret.
5. Provide `KEYLO_MCP_TOKEN` in the environment launching Claude Code, using your secret manager or a shell prompt that does not echo the input. Do not put the value in a command argument, shell history, source control, or a committed environment file.
6. Restart Claude Code, approve the project MCP server, and use `/mcp` to check the connection. These settings follow the [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp).

Example request: “Translate the missing French and Dutch copy in Keylo. Read each key's context, preserve placeholders, and save the translations.” Select both languages when issuing the credential.

For multiple projects, use separate credentials, unique server names in `mcpServers` (such as `keylo-website` and `keylo-mobile`), and separate environment variables. Each connection has access to exactly one project. The app does not configure your Claude installation or transmit copy until you connect and call tools.

## Tools and write behavior

| Tool | Purpose |
| --- | --- |
| `get_project` | Project description, source language, allowed target languages, overwrite policy. |
| `list_keys` | Search/context previews with cursor pagination, namespace and permitted-language filters; missing-only by default. Default 20, maximum 50 items. Continue if `nextCursor` is present, even if a page is empty. |
| `get_key` | Complete source, key context, selected target translations, and current version. |
| `set_translations` | Atomic batch of 1–10 existing keys, each with `expectedVersion` and target translations. |

Writes cannot create/delete keys, change source copy or key metadata, clear text, or touch settings, users, and credentials. Reading exposes source text and metadata plus translations in the selected target languages. No bulk project export tool is exposed. Searches use the project's existing text index, which includes all translation languages; matching a key does not return other target texts.

Every batch validates before committing and writes all keys, counters, and a success audit event in one transaction. A stale version returns a tool error with status `409`; re-read the affected keys and resolve the changed copy before retrying. A batch failure saves nothing. Key records show the Claude connection name as editor; audit records also retain the owning actor ID and credential ID.

Replacing a non-empty translation requires **both** an overwrite-enabled credential and `overwriteExisting: true` in the call. Treat this as a privileged scope. Claude gets instructions to preserve placeholders, ICU structure, formatting, and whitespace, and to treat copy as untrusted data. The server also validates supported placeholder contracts (ICU arguments/types, named templates, printf types, key references and exact formatting tags) before saving. Missing, extra or incompatible placeholders reject the whole batch. This does not guarantee translation quality or validate every application-specific grammar; check your application's output as appropriate.

## Credential lifecycle and deployment

- Credentials have 256 random bits; only SHA-256 digests and a short display prefix are stored. Lists expose owner name, scopes, expiry, and last use (updated at most once a minute). Full credentials never appear in lists or audit events.
- Local-account credentials last 1–30 days (default 7). Every request checks the owner's current account status, project-manager permission, and authorization epoch. Disabling the account, changing its access/password, or revoking all its sessions invalidates these credentials. Ordinary sign-out ends the browser session; revoke the connection separately, or use **Your account → Sign out and revoke my connections**.
- OIDC/SAML credentials expire no later than the issuing sign-in's absolute expiry, within one hour. Every authentication checks the owner's current central directory permissions and access epoch. They do not extend when the browser signs in again. Ordinary sign-out does not revoke these credentials; revoke the connection separately. Configure [SSO provisioning and reconciliation](sso-lifecycle.md) for upstream changes.
- Revocation and expiry are checked on every HTTP request. Translation commits also conditionally check the credential and current owner/directory state, blocking a racing revocation that commits first. Reads already running may finish, and committed work cannot be recalled. Changing `AUTH_MODE` invalidates connections issued in another mode. Demo credentials still require a bearer token and work only on loopback, outside production.
- Export tokens cannot authenticate MCP; MCP credentials cannot authenticate browser/REST/export APIs. Cookies and demo fallback do not authenticate `/mcp`.
- `/mcp` validates `Host` against `APP_ORIGIN` and rejects foreign `Origin` values when present. Machine clients may omit `Origin`. There is no general cross-origin allowlist or cookie-auth bypass elsewhere. Preserve the configured public Host through a reverse proxy; never trust an arbitrary forwarded Host. HTTPS is required in production.
- POST bodies are bounded at 256 KiB, and each valid credential has a shared 120-request/minute fixed-window limit. Requests use independent stateless transports and JSON responses, without a long-lived SSE session or sticky routing. The existing AWS container/API Gateway route supports this endpoint without additional MCP infrastructure. Verify your deployed public hostname, proxy routing, authorization, and gateway limits before use.
- Successful credential creation/revocation and translation writes enter `AUTH_AUDIT`, including actor, project, credential, timestamp, outcome, and affected keys/locales, without copy text or bearer secrets. Monitor these records using the same database retention/export policy as other security events.

Run `npm test` and, after building, `npm run smoke:mcp` for the security and official-SDK protocol checks. The HTTP smoke uses a disposable SQLite database and synthetic translations; it does not connect to an Anthropic account.
