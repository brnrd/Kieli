# SAML 2.0 SSO

Set `AUTH_MODE=saml` when your organization requires SAML. Built-in accounts (`local`) and Okta OIDC (`okta`) remain separate deployment choices. Only one mode is active; SAML does not enable a password fallback or link identities by email.

Keylo is a single-IdP service provider (SP). It sends a signed AuthnRequest over **HTTP-Redirect** and receives a signed SAML Response over **HTTP-POST**. Start sign-in at Keylo. Unsolicited IdP-initiated responses are rejected.

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
  -subj "/CN=Keylo SAML signing" \
  -keyout keylo-saml.key -out keylo-saml.crt
```

Keep the private key out of Git, logs, chat, and the browser. Give the **public certificate** to your IdP so it can verify signed requests. Keylo publishes it in signed SP metadata. The certificate must match the private key and be within its validity dates.

Obtain the IdP's signing certificate through a trusted administrator/metadata exchange. Keylo trusts only the configured certificate, not a certificate embedded in an incoming response. Automatic remote metadata fetching is deliberately absent. `SAML_IDP_CERT` accepts a PEM bundle of up to three certificates for planned rollover; only currently valid RSA certificates are used.

## Okta configuration

Create a **SAML 2.0** app integration, then configure:

- **Single sign-on URL:** the ACS above. Use that same exact URL for Recipient and Destination.
- **Audience URI:** the SP entity ID above.
- **Name ID format:** Persistent (`urn:oasis:names:tc:SAML:2.0:nameid-format:persistent`). Map the application username to an immutable directory identifier, for example `user.getInternalProperty("id")`, rather than an email or editable profile field. Keep that mapping stable.
- **Default RelayState:** leave blank. Keylo generates a one-time value; it is never a redirect URL.
- **Response:** Signed. **Assertion Signature:** Signed. Require both.
- **Signature Algorithm:** RSA-SHA256. **Digest Algorithm:** SHA256.
- **Assertion Encryption:** Unencrypted. HTTPS protects transport; encrypted assertions are not supported by this implementation.
- Upload the SP public certificate and enable **Signed Requests**. The request includes the persistent NameIDPolicy.
- Leave **Single Logout** disabled. Keylo's sign-out revokes its local server session; it does not log out the entire IdP session.
- Assign the intended people/groups and enforce your organization's MFA policy in the app's sign-in policy.

Send these case-sensitive Attribute Statements:

| Attribute | Example Okta expression / mapping              |
| --------- | ---------------------------------------------- |
| `email`   | `user.email` (display/contact data only)       |
| `name`    | `user.firstName + " " + user.lastName`         |
| `groups`  | Group Attribute Statement filtered to `^keylo` |

Groups use the existing rules: `keylo-admin` grants workspace admin; `keylo:<project-id>:admin`, `:manager`, or `:user` grants that exact project role. The highest matching role wins. Missing groups grant no project access. Keylo accepts up to 500 group values; filter unrelated groups at the IdP.

Copy Okta's **Identity Provider Single Sign-On URL**, **Identity Provider Issuer**, and trusted **X.509 signing certificate** into the settings below. For an Okta dashboard entry, use a bookmark to Keylo's start-sign-in URL; a direct IdP-initiated SAML app launch has no corresponding Keylo login request and is rejected.

## Runtime configuration

```dotenv
NODE_ENV=production
AUTH_MODE=saml
APP_ORIGIN=https://copy.example.com
SAML_ENTRY_POINT=https://example.okta.com/app/YOUR_APP/sso/saml
SAML_IDP_ISSUER=http://www.okta.com/YOUR_APP_ID
# Optional; defaults to APP_ORIGIN/auth/saml/metadata:
SAML_SP_ENTITY_ID=https://copy.example.com/auth/saml/metadata
STORAGE_DRIVER=dynamodb
DYNAMODB_TABLE=your-table
AWS_REGION=eu-west-1
SAML_SECRETS_ARN=arn:aws:secretsmanager:REGION:ACCOUNT:secret:keylo-saml-...
```

On AWS, the referenced Secrets Manager JSON must contain `SAML_IDP_CERT`, `SAML_SP_PRIVATE_KEY`, and `SAML_SP_CERT`, each a PEM string. Enter them through your trusted secret-entry workflow. The runtime reads this one secret and caches it for at most five minutes. This avoids Lambda's environment-size limit for multiple PEM certificates and keys. The SAM role grants `GetSecretValue` only for that ARN. The default AWS-managed Secrets Manager encryption key needs no additional template permission; a customer-managed KMS key requires an explicitly scoped runtime decrypt grant.

For a standalone operator/dev setup, omit `SAML_SECRETS_ARN` and set the three PEM environment values directly. Quoted `.env` values can contain escaped `\n` newlines. There is no `SESSION_SECRET` requirement in SAML mode. HTTPS is required in development too; use a trusted local HTTPS reverse proxy or a staging deployment for a real browser round trip.

## AWS deployment

Select `AuthMode=saml` and supply `AppOrigin`, `SamlEntryPoint`, `SamlIdpIssuer`, and `AppSecretsArn`. Supply `SamlSpEntityId` only when overriding the default. OIDC-only parameters are unused. See [AWS deployment](aws.md).

If you need the generated API Gateway hostname before configuring Okta, deploy an empty `AuthMode=local` stack first without bootstrapping any account. Read its URL, configure SAML in Okta/Secrets Manager, then redeploy the same stack with the real `AppOrigin` and SAML parameters. There is no public first-visitor signup.

## Validation and sessions

The maintained `@node-saml/node-saml` library verifies both XML signatures, audience, issuer, temporal constraints, and request correlation. Keylo also enforces exact destination/recipient, a bearer confirmation, a persistent subject, explicit expiry, and SHA-256-or-stronger RSA signatures. It rejects XML DTDs/entities, malformed/duplicate form fields, multiple assertions, unsigned content, and bodies over 256 KB.

Requests live for ten minutes; assertions must be issued within five minutes, with one minute of clock tolerance. Keep servers and the IdP time-synchronized. A browser-bound Secure/HttpOnly/SameSite=None cookie is used **only** for the SAML callback, with path `/auth/saml` and a ten-minute lifetime. RelayState and the browser secret are independent. The main session remains SameSite=Lax. The ordinary Origin check is bypassed only for POST to the active SAML ACS; this endpoint instead requires the complete one-time protocol validation. All other writes still require exact `APP_ORIGIN`.

Requests, one-time browser flows, and assertion replay markers use shared database records and atomic conditional writes, including when separate Lambda instances handle the request and callback. DynamoDB TTL cleans up expired records eventually; validation checks expiry without waiting for deletion.

The session contains a verified role snapshot server-side. The cookie contains only a random opaque identifier. Identities use the IdP issuer plus persistent NameID, never email. Sessions last at most one hour, are capped by `SessionNotOnOrAfter` when supplied, expire after 30 minutes idle, and are revoked on Keylo sign-out. Successful reauthentication also revokes the prior browser session captured at initiation, even when its SameSite=Lax cookie is absent on the IdP POST. SAML login success/failure events omit assertions, credentials, and profile attributes.

**Lifecycle boundaries:** this adds SAML authentication. SCIM, IdP lifecycle events, automatic offboarding/reconciliation, SAML Single Logout, assertion encryption, and IdP-initiated login are not implemented. Disabling someone in Okta blocks new IdP authentications but does not yet push revocation into existing Keylo sessions. Existing sessions can retain the role snapshot for up to one hour. Translation contributions remain intact. Do not treat the SAML implementation as closing those separate lifecycle gaps.

## Verification

```sh
npm test
npm run build
npm run smoke:saml
```

The SAML tests require OpenSSL to create disposable test-only certificates. They exercise actual XML signatures, tampering, replay/concurrency, wrong issuer/audience/destination/recipient, expiry, browser binding, roles, and opaque session logout. The compiled HTTP check verifies the cross-site POST callback and that other cross-origin writes remain blocked. It uses a local signing fixture; a real Okta tenant, browser/proxy cookie behavior, MFA policy, Secrets Manager permissions, DynamoDB concurrency, and certificate rollover still require integration verification before rollout.

References: [Okta SAML app fields](https://help.okta.com/en-us/Content/Topics/Apps/aiw-saml-reference.htm), [Okta user identifiers](https://developer.okta.com/docs/reference/okta-expression-language/#okta-user-id-and-status), [Node-SAML](https://github.com/node-saml/node-saml).
