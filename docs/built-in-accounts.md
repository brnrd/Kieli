# Built-in accounts

Set `AUTH_MODE=local` to run Keylo without an identity provider. The same projects, permissions, exports, and CLI work with built-in accounts, Okta OIDC, or SAML. One authentication mode is enabled per deployment; local credentials are never a fallback that bypasses an SSO-only deployment.

## First administrator

For the prebuilt AWS installer, use its [protected first-run web setup](aws-one-click.md) instead of the bootstrap command below. It requires the setup token retrieved from your own AWS account and shares the same one-time initialization guard.

For local development, copy `.env.example` to `.env` and set:

```dotenv
AUTH_MODE=local
APP_ORIGIN=http://localhost:4321
STORAGE_DRIVER=sqlite
SQLITE_PATH=.data/keylo.sqlite
```

Then run from the checkout:

```sh
npm ci
npm run users:bootstrap -- --email admin@example.com --name "Workspace admin"
npm run dev
```

The bootstrap command creates the first invited administrator and prints a private, one-time activation URL. Open that URL to choose your own password. It expires in 24 hours. The command accepts no password and can initialize a workspace only once. There is no public signup or first-visitor admin endpoint. Do not copy a real activation link into an issue, public log, or chat transcript.

Use the hostname and port matching `APP_ORIGIN`. Built-in authentication permits HTTP only on loopback outside production. Production requires HTTPS. No email service, Okta credentials, or `SESSION_SECRET` is required in local mode.

## People & access

Workspace admins get a **People & access** screen:

- Create a person by name/email and generate an activation link.
- Assign workspace admin or member access. Workspace admins can access every project and manage users. Members receive project-specific user, manager, or project-admin roles.
- Search projects when assigning access; hundreds of assignments stay in the database, not the cookie.
- Disable or re-enable accounts. Contributions remain intact.
- Generate password-reset links for active users, or new activation links for invited users.
- Revoke all of a user's sessions.
- Read paginated security events for login, activation, recovery, password changes, and account/access administration.

Activation/reset URLs are shown only when issued. Share them through a private, trusted channel with the intended recipient. Keylo does not send emails automatically. Invites expire in 24 hours; password-reset links expire in 30 minutes. Links are single-use and stored only as SHA-256 hashes. Account/access edits invalidate outstanding links; issue a fresh one after an edit if needed.

There must always be at least one **active** workspace admin. An invited admin does not count until they activate their account. Disabling or demoting the last active admin is rejected transactionally, including concurrent changes. Managing users requires a sign-in within the last 15 minutes; sign in again if asked.

Users can change their own password under **Your account**, by supplying the current password. The new password must have 15–128 Unicode characters and pass a common-password/pattern strength check. Password managers and long, unique passphrases are supported. No arbitrary uppercase/symbol composition rule or scheduled password change is imposed. Passwords are NFC-normalized and hashed with Argon2id (19 MiB, two iterations, one lane) using `@node-rs/argon2`.

## Sessions and offboarding

The browser holds a random 256-bit opaque session identifier in an HttpOnly, SameSite=Lax cookie, Secure over HTTPS. Session records store a hash of that identifier in the configured database. Local sessions expire after eight hours or 30 minutes of inactivity; activity is persisted at most every five minutes. Authorization and user status are read from the user record on each request.

Disabling an account, editing access, recovering an account, changing a password, or using **Sign out everywhere** invalidates previous sessions through a per-user authentication version. A request already in progress may finish, but subsequent requests fail. Password change keeps the current browser signed in with a newly issued session. Normal sign-out deletes the current server-side session, so replaying the old cookie fails.

Existing project export tokens are project integration credentials. They remain valid until their own expiry or explicit revocation; disabling their creator does not automatically break a CI pipeline. Review and revoke relevant tokens when offboarding a maintainer.

Login uses generic errors for unknown, invited, disabled, and incorrect-password accounts. Password work also runs for unknown/disabled accounts. Login throttling is stored in the shared database: ten attempts per email per fixed 15-minute window, with an additional 1,000-attempt client-address bucket. Proxies that don't supply a validated client address share the latter bucket. Account throttling still applies independently. Activation and password-change attempts have separate limits. Gateway throttling complements these controls on AWS.

## Administrator recovery

An operator with trusted database access can issue a fresh activation/reset link for an enabled local administrator:

```sh
npm run users:recover -- --email admin@example.com
```

This invalidates that administrator's existing sessions and outstanding setup links immediately. It does not change the password until the new link is used. Treat database/operator credentials as root access. This recovery command is never exposed as an anonymous web endpoint.

## AWS

Deploy the SAM template with `AuthMode=local` (its default), configure the actual HTTPS `AppOrigin`, and skip all Okta-only parameters. Bootstrap from a trusted operator checkout configured for the deployed table:

```sh
AUTH_MODE=local \
APP_ORIGIN=https://YOUR-KEYLO-HOST \
STORAGE_DRIVER=dynamodb \
DYNAMODB_TABLE=YOUR-TABLE \
AWS_REGION=eu-west-1 \
npm run users:bootstrap -- --email admin@example.com --name "Workspace admin"
```

The operator's AWS identity must be authorized to access that table. No AWS account changes are performed by the CLI beyond these user records. DynamoDB TTL cleans up expired sessions, setup links, and rate-limit buckets eventually; expiry is enforced on every request independently. SQLite removes expired ephemeral records when a connection is opened. Security-event retention is currently manual; set an organizational retention/export policy before a broad deployment.

## Boundaries

This first built-in mode uses email/password with administrator-issued activation/reset links. Self-service email delivery, local MFA/passkeys, SCIM, and automatic identity-provider offboarding are not implemented. Okta remains available when your organization requires centrally enforced MFA and identity lifecycle policies. Accounts are not automatically linked by matching email when switching modes.

References: [OWASP password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html), [OWASP authentication guidance](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html).
