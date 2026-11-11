# Deploy on AWS without Docker

Kieli runs in a Node.js 24 Lambda from a ZIP using Lambda Web Adapter. API Gateway supplies HTTPS; DynamoDB stores projects, sessions and translations. A separate scheduled Lambda runs maintenance. Both frontend rendering and backend routes currently run in the application Lambda. Further separation remains a [plan](lambda-backend-plan.md), not a requirement for Docker-free operation.

## Install with Terraform

Follow the [Terraform ZIP example](../infra/terraform/README.md). It reuses the shared CloudFormation installer, preserving authentication, scoped IAM, scheduling, backups and protected administrator setup. Terraform manages the stack, and CloudFormation owns its nested resources.

The installer accepts `AuthMode=local|okta|saml`. Local accounts use protected first-administrator setup. OIDC/SAML require the existing IdP settings and secret ARNs described in [installer configuration](aws-one-click.md), [OIDC](okta.md) and [SAML](saml.md). Optional SCIM and reconciliation retain their [lifecycle configuration](sso-lifecycle.md). Custom HTTPS domains, certificates and DNS are operator-managed.

## Build from source without Docker

Use Node.js 24.2+ on Linux x64/glibc, including an ordinary Linux CI runner:

```sh
npm ci
npm run check
npm test
npm run build
npm run package:aws
```

The release ZIP includes the server, static frontend assets, traced dependencies and native Linux Argon2 binary. Packaging verifies architecture and records checksums in `.aws-release/release.json`. On macOS, the `--local-test` packaging option is only for local QA and is not deployable. The [AWS release workflow](../.github/workflows/aws-release.yml) packages on Linux without Docker or ECR.

Upload a verified publishable ZIP into a versioned regional S3 bucket using your authorized release workflow, then provide its bucket/key/object version to Terraform. See the example for exact steps. No public artifact bucket or install button is published yet; the repository can build artifacts without a configured AWS account. Building and rendering templates do not deploy or publish anything.

The same ZIP installer supports a guided [CloudFormation installation](aws-one-click.md) when release hosting is configured. There is no SAM image template or Dockerfile in the supported workflow.

## Operations and verification

- DynamoDB uses `pk`/`sk` strings, on-demand capacity, encryption, TTL, point-in-time recovery and deletion protection. The installer retains the table on stack deletion. Project snapshots and recoverable deleted keys provide application-level recovery too.
- Secrets stay in Secrets Manager. Rotate values and increment `SecretsRevision` to refresh environments; revoke database sessions and integration credentials separately when required. Custom KMS keys need scoped decrypt permissions for the appropriate deployment/runtime principal.
- The generated API URL sets the exact `APP_ORIGIN` in one deployment. Verify callbacks, cookies and origin checks under the actual public hostname. No VPC or NAT gateway is required.
- Logs have bounded retention and omit bodies, query strings, cookies and authorization headers in access logs. Review throttling, concurrency, request sizes and export payload limits against actual usage.
- Maintenance runs every five minutes, including optional configured identity reconciliation, with existing bounded retries and progress behavior.
- Run real sign-in/logout, SAML SLO, offboarding, project-role, credential-revocation, concurrent-write and backup-restore checks in staging before production. Local fixtures and template lint are not live AWS or IdP verification.

## Existing image deployments

The legacy Docker/SAM path has been removed from the repository. Existing deployments are not modified automatically. Do not deploy a new ZIP stack over an existing image stack or point a fresh empty table at production traffic. Explicitly plan resource ownership, retained data/restore, secrets, external origin, callback settings and traffic cutover. Keep a rollback path; do not delete the old stack as a migration step without handling its retained table.

For a non-AWS server, use [standalone Node.js](standalone.md).

References: [Lambda Web Adapter](https://github.com/aws/aws-lambda-web-adapter), [DynamoDB transactions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transactions.html).
