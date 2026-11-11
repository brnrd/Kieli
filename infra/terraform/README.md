# Terraform ZIP installation (no Docker)

This example uses Terraform's AWS provider to manage Kieli's existing **ZIP CloudFormation installer**. Terraform owns the stack; CloudFormation owns its Lambda, API Gateway, DynamoDB, Secrets Manager, IAM, logs and maintenance schedule. It is not a native Terraform resource-by-resource module. Keeping one installer definition avoids divergent security and authentication behavior.

The application already runs on Lambda: the ZIP contains the Astro Node server and dependencies, started by `run.sh` through the Lambda Web Adapter layer. No ECR repository, image build, Docker daemon, SAM CLI, VPC or NAT gateway is needed for this path. The frontend and backend currently share one application Lambda; maintenance has a separate scheduled runner.

## Prepare an artifact

Use a verified Linux x64/glibc release ZIP from the existing packaging workflow, or build on Linux x64 with Node.js 24.2+:

```sh
npm ci
npm run check
npm test
npm run build
npm run package:aws
```

The ZIP's native Argon2 dependency must match Linux x64/glibc. A macOS `--local-test` package cannot be deployed. Docker is not required to package on a Linux runner. The current release workflow creates downloadable build artifacts even when publishing is unconfigured; there is no public release bucket yet.

Verify `release.json` and the ZIP checksum. Put the publishable ZIP under `releases/` in a **version-enabled S3 bucket in the target region**, recording its object version. The bucket/artifact is an operator prerequisite, not created by this example. For example, from an authorized release environment:

```sh
aws s3api put-object --region eu-west-1 \
  --bucket YOUR-VERSIONED-RELEASE-BUCKET \
  --key releases/0.1.0/YOUR-VERIFIED-LINUX-ZIP.zip \
  --body .aws-release/YOUR-VERIFIED-LINUX-ZIP.zip
```

Use the returned `VersionId`, not the ETag or the string `null`. This command publishes an artifact; none of these commands have been run against AWS as part of developing this example. Use a private same-account bucket with the deployment principal authorized to read it. Customer-managed encryption keys need corresponding scoped decrypt permissions.

## Configure and install

From the repository root, render the shared installer into an ignored local file:

```sh
node scripts/render-terraform-template.mjs
cp infra/terraform/terraform.tfvars.example infra/terraform/terraform.tfvars
```

Edit the copied variables file with your region and immutable release coordinates. It contains no credentials. Keep AWS credentials in your normal AWS profile, environment or CI federation. Local accounts are the default. SSO accepts the same parameter names as the [ZIP installer](../../docs/aws-one-click.md); existing secret **ARNs** are supplied instead of secret values. CloudFormation resolves OIDC values, while SAML and lifecycle secrets are read at runtime by the scoped application role. This example does not read secret contents into Terraform state.

```sh
terraform -chdir=infra/terraform init
terraform -chdir=infra/terraform fmt -check
terraform -chdir=infra/terraform validate
terraform -chdir=infra/terraform test # mocked AWS provider; no deployment
terraform -chdir=infra/terraform plan -out=install.tfplan
# Review the plan, IAM and the generated CloudFormation template, then:
terraform -chdir=infra/terraform apply install.tfplan
terraform -chdir=infra/terraform output installation
```

The generated API URL becomes `APP_ORIGIN` in the same deployment. For local accounts, use the `SetupUrl` and retrieve the token from Secrets Manager using `SetupSecretArn` through your approved secret-entry workflow; follow [first-administrator setup](../../docs/aws-one-click.md). Custom domains, DNS and certificates remain operator-managed. Use the exact external HTTPS origin when providing `AppOrigin`.

State and saved plans can contain infrastructure metadata: configure your team's encrypted, access-controlled remote state backend before shared use. The example deliberately does not prescribe/create a state bucket. Keep the included `.terraform.lock.hcl` in your deployment repository to pin the resolved provider and checksums; the application repo does not need your variables or state.

## Updates and recovery

For an upgrade, render the installer again from the intended checkout, update `release` to the verified ZIP/version and run plan/apply. Retain previous versioned artifacts for rollback. Do not independently edit the nested resources with Terraform or another deployment system. Inspect CloudFormation updates/change sets for nested resource replacements; Terraform shows the stack/template diff, not a native resource-by-resource plan. A version number is operator-supplied metadata, not proof of ZIP authenticity.

`prevent_destroy` blocks ordinary Terraform teardown; the reused installer retains DynamoDB and enables deletion protection/PITR. Intentional decommissioning requires separately reviewing/removing those protections and handling retained data. Do not apply this example over an existing SAM/image stack or import its resources as a fresh install: migration requires an explicit ownership/data plan.

Validation is local only: Terraform formatting/schema validation, template rendering/lint and IAM/configuration inspection do not establish a successful AWS deployment or real IdP configuration. No AWS resources or artifacts were deployed/published during this change.

References: [Terraform CloudFormation stack resource](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/cloudformation_stack), [Lambda Web Adapter ZIP example](https://github.com/aws/aws-lambda-web-adapter/tree/main/examples/expressjs-zip).
