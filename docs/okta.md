# Okta setup

This page covers **OIDC** (`AUTH_MODE=okta`). For an organization requiring **SAML 2.0**, use `AUTH_MODE=saml` and the [SAML guide](saml.md).

1. Create an **OIDC Web Application** with Authorization Code enabled. Keylo is a server-side confidential client, not an SPA. Register `https://<your-keylo-host>/auth/callback` as a sign-in redirect URI and assign the appropriate people/groups to the application.
2. Configure the issuer and client credentials. The default configuration uses a custom issuer such as `https://example.okta.com/oauth2/default`; verify that it has an access policy. Your Okta plan determines custom authorization-server availability.
3. Include a `groups` claim in the **ID token** containing the assigned `keylo-admin` and `keylo:<project-id>:<role>` groups. Restrict its filter to `^keylo` and request `openid profile email groups`. If your authorization server uses a different scope for the claim, set `OKTA_SCOPES` accordingly.
4. Create `keylo-admin` and assign the initial administrator. Create project groups after choosing a project ID, for example `keylo:acme-website:manager` and `keylo:acme-website:user`. Project groups grant access only to that exact project ID. The highest assigned role wins.
5. Generate an OIDC login-state encryption key with `openssl rand -hex 32`. Keep it and the client secret out of source control. On AWS, use the Secrets Manager JSON described in the deployment guide.

```dotenv
NODE_ENV=production
AUTH_MODE=okta
APP_ORIGIN=https://copy.example.com
OKTA_ISSUER=https://example.okta.com/oauth2/default
OKTA_CLIENT_ID=your-client-id
OKTA_CLIENT_SECRET=your-client-secret
SESSION_SECRET=your-64-character-random-hex-value
STORAGE_DRIVER=dynamodb
DYNAMODB_TABLE=your-table
AWS_REGION=eu-west-1
```

Authorization Code, PKCE S256, state, nonce, issuer, ID-token signature, and audience validation are handled through `openid-client`. Tokens are exchanged server-side; browser cookies contain an opaque session identifier. The session and verified identity snapshot live in the shared database, not in the cookie. Sessions expire within an hour or the ID token's remaining lifetime, whichever is shorter, and after 30 minutes of inactivity. Local sign-out deletes the server-side session. Okta group changes/deactivation do not yet push into existing sessions; their snapshot remains valid until expiry. Filter the groups claim to Keylo groups and test large memberships against your issuer's limits. The `SESSION_SECRET` encrypts the short-lived PKCE/state/nonce login cookie; rotating it invalidates pending login attempts, not already-created database sessions.

Updating from the original identity-cookie implementation signs existing users out once. There is no automatic linking to built-in accounts by email.

The API accepts **Keylo project export tokens**, not arbitrary Okta bearer access tokens. Supporting Okta machine-to-machine access would require a separately validated custom authorization server, audience, and scopes.

References: [Okta authorization servers](https://developer.okta.com/docs/concepts/auth-servers/), [Okta groups claims](https://developer.okta.com/docs/guides/customize-tokens-groups-claim/main/), [openid-client](https://github.com/panva/openid-client).
