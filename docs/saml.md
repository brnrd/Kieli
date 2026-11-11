# SAML 2.0 SSO

Set `AUTH_MODE=saml` when your organization requires SAML. Built-in accounts (`local`) and Okta OIDC (`okta`) remain separate deployment choices. Only one mode is active; SAML does not enable a password fallback or link identities by email.

Kieli is a single-IdP service provider (SP). It sends a signed AuthnRequest over **HTTP-Redirect** and receives a signed SAML Response over **HTTP-POST**. Start sign-in at Kieli. Unsolicited IdP-initiated responses are rejected.

## Endpoints

For `APP_ORIGIN=https://copy.example.com`:

| Setting                          | Value                                         |
| -------------------------------- | --------------------------------------------- |
| Start sign-in                    | `https://copy.example.com/auth/login`         |
| Assertion Consumer Service (ACS) | `https://copy.example.com/auth/saml/acs`      |
| Public SP metadata               | `https://copy.example.com/auth/saml/metadata` |
| Default SP entity ID / audience  | `https://copy.example.com/auth/saml/metadata` |

Set `SAML_SP_ENTITY_ID` if your organization requires a different, stable identifier. Both sides must agree exactly on the audience, ACS, recipient, destination, and IdP issuer. Entity IDs are identifiers; an Okta issuer beginning with `http://www.okta.com/` is valid even though all network endpoints must use HTTPS.

## Signing material

Use a dedicated RSA signing key (at least 2048 bits) and its current X.509 certificate. For example, generate a 3072-bit key in a protected operator directory:

```sh
umask 077
openssl req -x509 -newkey rsa:3072 -nodes -sha256 -days 365 \
  -subj "/CN=Kieli SAML signing" \
  -keyout kieli-saml.key -out kieli-saml.crt
```

Keep the private key out of Git, logs, chat, and the browser. Give the **public certificate** to your IdP so it can verify signed requests. Kieli publishes it in signed SP metadata. The certificate must match the private key and be within its validity dates.

Obtain the IdP's signing certificate through a trusted administrator/metadata exchange. Kieli trusts only the configured certificate, not a certificate embedded in an incoming response. Automatic remote metadata fetching is deliberately absent. `SAML_IDP_CERT` accepts a PEM bundle of up to three certificates for planned rollover; only currently valid RSA certificates are used.

## Okta configuration

Create a **SAML 2.0** app integration, then configure:

- **Single sign-on URL:** the ACS above. Use that same exact URL for Recipient and Destination.
- **Audience URI:** the SP entity ID above.
- **Name ID format:** Persistent (`urn:oasis:names:tc:SAML:2.0:nameid-format:persistent`). Map the application username to an immutable directory identifier, for example `user.getInternalProperty("id")`, rather than an email or editable profile field. Keep that mapping stable.
- **Default RelayState:** leave blank. Kieli generates a one-time value; it is never a redirect URL.
- **Response:** Signed. **Assertion Signature:** Signed. Require both.
- **Signature Algorithm:** RSA-SHA256. **Digest Algorithm:** SHA256.
- **Assertion Encryption:** Unencrypted. HTTPS protects transport; encrypted assertions are not supported by this implementation.
- Upload the SP public certificate and enable **Signed Requests**. The request includes the persistent NameIDPolicy.
- Optionally enable **Single Logout** using the setup below. Leave it disabled if `SAML_LOGOUT_URL` is unset.
- Assign the intended people/groups and enforce your organization's MFA policy in the app's sign-in policy.

Send these case-sensitive Attribute Statements:

| Attribute | Example Okta expression / mapping              |
| --------- | ---------------------------------------------- |
| `email`   | `user.email` (display/contact data only)       |
| `name`    | `user.firstName + " " + user.lastName`         |
| `groups`  | Group Attribute Statement filtered to `^kieli` |

Groups use the existing rules: `kieli-admin` grants workspace admin; `kieli:<project-id>:admin`, `:manager`, or `:user` grants that exact project role. The highest matching role wins. Missing groups grant no project access. Kieli accepts up to 500 group values; filter unrelated groups at the IdP.

Copy Okta's **Identity Provider Single Sign-On URL**, **Identity Provider Issuer**, and trusted **X.509 signing certificate** into the settings below. For an Okta dashboard entry, use a bookmark to Kieli's start-sign-in URL; a direct IdP-initiated SAML app launch has no corresponding Kieli login request and is rejected.

## Runtime configuration

```dotenv
NODE_ENV=production
AUTH_MODE=saml
APP_ORIGIN=https://copy.example.com
SAML_ENTRY_POINT=https://example.okta.com/app/YOUR_APP/sso/saml
# Optional: use the IdP's actual Single Logout URL, not its SSO URL.
SAML_LOGOUT_URL=https://example.okta.com/app/YOUR_APP/slo/saml
SAML_IDP_ISSUER=http://www.okta.com/YOUR_APP_ID
# Optional; defaults to APP_ORIGIN/auth/saml/metadata:
SAML_SP_ENTITY_ID=https://copy.example.com/auth/saml/metadata
STORAGE_DRIVER=dynamodb
DYNAMODB_TABLE=your-table
AWS_REGION=eu-west-1
SAML_SECRETS_ARN=arn:aws:secretsmanager:REGION:ACCOUNT:secret:kieli-saml-...
```

On AWS, the referenced Secrets Manager JSON must contain `SAML_IDP_CERT`, `SAML_SP_PRIVATE_KEY`, and `SAML_SP_CERT`, each a PEM string. Enter them through your trusted secret-entry workflow. The runtime reads this one secret and caches it for at most five minutes. This avoids Lambda's environment-size limit for multiple PEM certificates and keys. The Lambda role grants `GetSecretValue` only for that ARN. The default AWS-managed Secrets Manager encryption key needs no additional template permission; a customer-managed KMS key requires an explicitly scoped runtime decrypt grant.

For a standalone operator/dev setup, omit `SAML_SECRETS_ARN` and set the three PEM environment values directly. Quoted `.env` values can contain escaped `\n` newlines. There is no `SESSION_SECRET` requirement in SAML mode. HTTPS is required in development too; use a trusted local HTTPS reverse proxy or a staging deployment for a real browser round trip.

## AWS deployment

Select `AuthMode=saml` and supply `AppOrigin`, `SamlEntryPoint`, `SamlIdpIssuer`, and `AppSecretsArn`. Supply `SamlSpEntityId` only when overriding the default, and `SamlLogoutUrl` to enable Single Logout. OIDC-only parameters are unused. See [AWS deployment](aws.md).

If you need the generated API Gateway hostname before configuring Okta, deploy an empty `AuthMode=local` stack first without bootstrapping any account. Read its URL, configure SAML in Okta/Secrets Manager, then redeploy the same stack with the real `AppOrigin` and SAML parameters. There is no public first-visitor signup.

## Validation and sessions

The maintained `@node-saml/node-saml` library verifies both XML signatures, audience, issuer, temporal constraints, and request correlation. Kieli also enforces exact destination/recipient, a bearer confirmation, a persistent subject, explicit expiry, and SHA-256-or-stronger RSA signatures. It rejects XML DTDs/entities, malformed/duplicate form fields, multiple assertions, unsigned content, and bodies over 256 KB.

Requests live for ten minutes; assertions must be issued within five minutes, with one minute of clock tolerance. Keep servers and the IdP time-synchronized. A browser-bound Secure/HttpOnly/SameSite=None cookie is used **only** for the SAML callback, with path `/auth/saml` and a ten-minute lifetime. RelayState and the browser secret are independent. The main session remains SameSite=Lax. The ordinary Origin check is bypassed only for POST to the active SAML ACS and logout callback. Those endpoints authenticate signed protocol messages; sign-in and app-initiated logout responses also require browser binding and correlation. The logout callback accepts signed HTTP-Redirect messages too. All other browser writes, including initiating logout, still require exact `APP_ORIGIN`.

Requests, one-time browser flows, and assertion replay markers use shared database records and atomic conditional writes, including when separate Lambda instances handle the request and callback. DynamoDB TTL cleans up expired records eventually; validation checks expiry without waiting for deletion.

Sessions refer to a central issuer/subject directory whose current permissions are checked on authentication. The cookie contains only a random opaque identifier. Identities use the IdP issuer plus persistent NameID, never email. Sessions last at most one hour, are capped by `SessionNotOnOrAfter` when supplied, expire after 30 minutes idle, and are revoked on Kieli sign-out. Successful reauthentication also revokes the prior browser session captured at initiation, even when its SameSite=Lax cookie is absent on the IdP POST. SAML login success/failure events omit assertions, credentials, and profile attributes.

**Lifecycle:** optional [SCIM provisioning and Okta reconciliation](sso-lifecycle.md) invalidate access after upstream changes arrive. Administrators can block/revoke access immediately in Kieli, preserving contributions. JIT-only deployments still refresh upstream groups at sign-in. Optional Single Logout ends sessions rather than deactivating an account; it complements provisioning. Assertion encryption and unsolicited IdP-initiated login remain unsupported.

## Single Logout

Single Logout (SLO) is optional. Configure `SAML_LOGOUT_URL` with the trusted IdP's HTTPS SLO endpoint (AWS parameter `SamlLogoutUrl`). Kieli uses its existing SP signing key/certificate and pinned IdP certificates; no extra secret or infrastructure is required. Never substitute the ordinary SSO URL or an arbitrary return URL.

When enabled, signed SP metadata advertises **HTTP-POST** SingleLogoutService at `APP_ORIGIN/auth/saml/logout`. The callback also accepts signed HTTP-Redirect messages. Kieli sends outbound LogoutRequest and LogoutResponse messages through signed **HTTP-Redirect**. Configure the IdP to accept that response binding; this version does not send outbound POST logout forms or process encrypted NameIDs.

For Okta, enable **Allow application to initiate Single Logout**, set **Single Logout URL** to `https://copy.example.com/auth/saml/logout`, **SP Issuer** to Kieli's entity ID, and upload the same SP public signing certificate. Copy the actual Okta SLO endpoint to `SAML_LOGOUT_URL`. If your tenant supports logout notifications to participating apps, configure that same Kieli callback and enable signed app notifications. Okta feature availability and field names can vary; verify the resulting requests and bindings in staging. See [Okta Single Logout configuration](https://help.okta.com/en-us/Content/topics/apps/apps_single_logout.htm).

**Your account → Sign out** offers two actions when SLO is configured:

- **Sign out of Kieli** revokes this browser session only. The sidebar sign-out also remains local-only.
- **Sign out of Kieli and identity provider** revokes local access first, fences other Kieli sessions for the same IdP session index (all this subject's sessions if no index was supplied), then sends the signed logout request. Provider sign-out can affect other participating apps. A verified, successful response confirms completion. Failure, partial logout, expiry or missing browser binding never reports success; the login screen explains that provider logout is unconfirmed. Closing the browser before the return leaves local access revoked but cannot establish provider logout.

Verified IdP-initiated LogoutRequests revoke matching Kieli browser sessions without requiring a browser cookie. Matching uses the exact issuer and persistent NameID; supplied NameQualifier/SPNameQualifier must match the issuer/SP entity ID. Up to 20 session indexes are revoked atomically; an absent index list revokes all sessions for that subject. Other users and unlisted session indexes remain active. Responses go only to the configured IdP endpoint. RelayState is an opaque value of at most 80 bytes, never a redirect destination.

Both callback bindings require RSA-SHA256 or RSA-SHA512 signatures from a pinned, current IdP certificate. Kieli rejects wrong destinations/issuers, malformed/ambiguous forms, DTDs/entities, unsigned messages, stale or future messages and replays. Messages must be issued within five minutes, with up to one minute of future clock tolerance; logout form/query and decompression limits are enforced. App-initiated responses also require the pending request ID, independent one-time RelayState and a ten-minute Secure/HttpOnly/SameSite=None cookie.

Shared conditional transactions publish replay markers, session revocation fences and audit events. Fences last two hours, beyond the maximum one-hour browser session and ten-minute in-flight login window; validation checks their expiry independently of eventual database TTL deletion. Sign-in flows started before a matching logout cannot restore access, even if session insertion races logout. An already-running request may finish. Audit events record hashed actor IDs and outcomes through action names, without NameIDs, session indexes, protocol payloads or credentials.

**Upgrade:** new SAML sign-ins retain validated logout context, including the SessionIndex, in the server-side session record; that context is not added to browser bootstrap or integration credentials. Enabling SLO invalidates older SAML sessions that lack this context; users sign in again. No translation data migration is needed. SLO configuration is optional, and removing it restores local-only logout; previously written revocation fences remain effective until expiry.

**Independent credentials:** SLO does not revoke MCP, export, source-sync or mobile credentials. Use **Sign out and revoke my connections** for account-wide Kieli/MCP revocation, administrator offboarding for access removal, and the relevant project credential controls for service keys. SLO does not disable the account or replace SCIM/reconciliation.

## Verification

```sh
npm test
npm run build
npm run smoke:saml
```

The SAML tests require OpenSSL to create disposable test-only certificates. They exercise actual XML signatures, tampering, replay/concurrency, wrong issuer/audience/destination/recipient, expiry, browser binding, roles, opaque session logout, signed POST/Redirect SLO, request/browser correlation, replay/concurrent revocation, failed provider responses and session-index isolation. The compiled HTTP check verifies login and SLO callbacks, local revocation before redirect, and that other cross-origin writes remain blocked. It uses a local signing fixture; a real Okta tenant, browser/proxy cookie behavior, MFA policy, Secrets Manager permissions, DynamoDB concurrency, certificate rollover, app-initiated logout, IdP-initiated logout notifications and partial/failing SLO still require integration verification before rollout.

References: [Okta SAML app fields](https://help.okta.com/en-us/Content/Topics/Apps/aiw-saml-reference.htm), [Okta user identifiers](https://developer.okta.com/docs/reference/okta-expression-language/#okta-user-id-and-status), [Node-SAML](https://github.com/node-saml/node-saml).
