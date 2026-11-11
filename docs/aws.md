# Deploy on AWS

For a **Docker-free Terraform installation**, use the [Terraform ZIP example](../infra/terraform/README.md). It manages the existing ZIP installer through CloudFormation, including the application and maintenance Lambdas. Further backend separation is described in the [Lambda plan](lambda-backend-plan.md); that split is not implemented.

For the guided **Deploy Kieli** distribution, see [AWS install button](aws-one-click.md). That path uses prebuilt versioned ZIPs, a generated HTTPS origin in one deployment, and protected web setup. It does not require a customer-side build. No public release bucket is configured yet. The instructions below remain the separate **source-built Docker/SAM path**; do not apply the ZIP template to an existing image stack without a reviewed migration.

The SAM stack runs the Astro Node server in Lambda using AWS Lambda Web Adapter. API Gateway provides HTTPS and throttling; DynamoDB uses on-demand billing with encryption, point-in-time recovery, and deletion protection. The runtime role can access only the app table and log group. All app assets are served by the same container.

Prerequisites: AWS CLI credentials for the target account, AWS SAM CLI, and Docker. Creating this stack incurs normal AWS charges. No resources are deployed by `npm run build`.

## 1. Choose authentication

Set `AuthMode=local` (the default) for built-in accounts. Skip the Okta/Secrets Manager parameters, deploy, set the exact HTTPS `AppOrigin`, and bootstrap the first administrator from a trusted checkout as described in [built-in accounts](built-in-accounts.md). No identity provider or email service is required. The operator uses their existing AWS credentials to write the initial user records.

For `AuthMode=okta`, create the Okta Web Application described in [Okta setup](okta.md). In AWS Secrets Manager, create a JSON secret with these fields:

```json
{
  "OKTA_CLIENT_SECRET": "your-Okta-web-app-client-secret",
  "SESSION_SECRET": "64-random-hex-characters-from-openssl-rand-hex-32"
}
```

Use your approved secret-entry workflow. Do not put real secrets in a tracked file or command argument. Record the secret ARN. The deployment principal must be able to read that secret; CloudFormation resolves the values into the encrypted Lambda environment. The runtime role does not need Secrets Manager access. If you encrypt the secret with a customer-managed KMS key, give the deployment principal the required decrypt permission.

For `AuthMode=saml`, use the [SAML setup guide](saml.md). Supply `SamlEntryPoint`, `SamlIdpIssuer`, `AppSecretsArn`, and optionally `SamlSpEntityId`. The referenced secret contains PEM strings in `SAML_IDP_CERT`, `SAML_SP_PRIVATE_KEY`, and `SAML_SP_CERT`. SAML loads them at runtime, avoiding Lambda's environment-size limit; the template grants read access only to that secret. For customer-managed KMS encryption, add a scoped runtime decrypt grant. OIDC credentials and `SESSION_SECRET` are not used in SAML mode.

## 2. Build and deploy

From the repository root:

```sh
sam build --template-file infra/template.yaml
sam deploy --guided --resolve-image-repos
```

Choose a stack name (for example `kieli`) and region, choose `AuthMode=local`, `okta`, or `saml`, and acknowledge IAM resource creation. Supply `OktaIssuer` and `OktaClientId` only for OIDC. Supply `AppSecretsArn` for either SSO mode and the SAML parameters only for SAML. If you already have a custom domain, set `AppOrigin` to it and configure API Gateway's custom domain/mapping and DNS separately. The stack does not provision Route 53 zones or certificates.

For the generated API Gateway hostname, leave `AppOrigin` as `https://setup.invalid` for this first deployment. The placeholder intentionally cannot complete login. Read the stack's `Url` output, then deploy again with that exact URL as `AppOrigin`. For Okta, also register `<Url>/auth/callback`. A built-in deployment needs only these overrides (keep guided configuration for other values):

```sh
sam deploy --parameter-overrides \
  AuthMode=local \
  AppOrigin=https://YOUR-API-ID.execute-api.eu-west-1.amazonaws.com
```

For Okta, keep `AuthMode=okta` and the issuer/client/secret parameters from the guided configuration. With built-in accounts, initialize an administrator using the deployed URL and table; with Okta, sign in as a `kieli-admin` member. Then create/import your first project. Only the health endpoint and static assets are public; project data requires authentication. Browser mutations also require a matching `APP_ORIGIN`.

## Operations

- **Data:** DynamoDB is authoritative. The table is retained on stack deletion and has deletion protection. Backups/PITR protect against key deletions; there is no end-user trash UI.
- **Secrets:** rotate the Secrets Manager value, increment `SecretsRevision`, and redeploy to refresh Lambda instances. OIDC resolves its secrets into environment values; SAML reads its one secret at runtime with a five-minute cache. The `SESSION_SECRET` is OIDC-only and protects pending login-state cookies. Revoke database sessions separately when responding to an incident. Coordinate SAML certificate rotation with the IdP; the configured IdP PEM bundle supports overlap with up to three certificates.
- **Tokens:** export tokens are project-scoped, expire within at most 365 days, and are revocable in the Developers tab. Store consuming tokens in CI secret stores and rotate before expiry.
- **Limits:** API Gateway throttles at 20 requests/second with burst 40; Lambda reserves up to 20 concurrent executions. Raise these after load testing. Import uses requests of at most 20 keys and 220 KB, below the backend's 256 KB JSON limit.
- **Logs:** request metadata and application errors go to 14-day CloudWatch logs. Access logs omit query strings, bodies, cookies, and authorization headers. The app logs error names/messages, not submitted copy or export tokens.
- **Sessions:** user/session/link/attempt records live in the table. DynamoDB TTL eventually removes expired ephemeral records; the app checks expiry synchronously. Built-in deactivation and access changes revoke previous sessions immediately.
- **Network:** the Lambda does not need a VPC; it reaches DynamoDB and, when enabled, Okta over HTTPS. No NAT gateway is required.
- **Exports:** Lambda/API Gateway synchronous response size is finite. The CLI caps responses at 25 MB, while API Gateway/Lambda may impose a lower payload limit. Pull fewer languages for large projects. Streaming or object-storage exports would be a future extension.
- **Verification:** run the configured sign-in flow (activation/reset for built-in mode, OIDC callback, or SAML cross-site POST), each role's permissions, a token export/revoke, a Lokalise import, and concurrent writes against the deployed stack before opening access to your organization. For SAML, also verify certificate rollover, Secrets Manager permissions, MFA policy, cookie handling through the real proxy, and the strict recipient/destination values.

References: [Lambda Web Adapter](https://github.com/aws/aws-lambda-web-adapter), [AWS SAM image functions](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/serverless-image-repositories.html), [DynamoDB transactions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transactions.html).

Optional SAML Single Logout uses `SamlLogoutUrl` in either template. Leave it empty to retain local-only sign-out. The existing SAML signing secret and data table are reused; IAM permissions are unchanged. See [SAML logout setup and staging checks](saml.md#single-logout).

## Optional SSO lifecycle configuration

Both templates accept `SsoProvisioningMode=jit|scim`, `ScimSecretArn` (plain provisioning token; required in SCIM mode), and `ReconciliationSecretArn` (JSON with `origin`, `appId`, `apiToken`). These options require OIDC or SAML. Secrets are operator-supplied and are never template outputs. The runtime receives read permission only for the configured secret ARNs; custom KMS keys need a separately scoped decrypt grant. When reconciliation is configured, the five-minute maintenance runner invokes it alongside snapshots, with bounded work and resumable progress. See [SSO lifecycle setup and limitations](sso-lifecycle.md) before enabling SCIM; provision an administrator and its pushed group first.
