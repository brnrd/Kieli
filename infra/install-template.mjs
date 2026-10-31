import { snapshotResources } from "./snapshot-runner.mjs";
// One organization per stack. Release packaging supplies immutable regional artifacts.
const ref = (name) => ({ Ref: name });
const sub = (value) => ({ "Fn::Sub": value });
const attr = (name, field) => ({ "Fn::GetAtt": [name, field] });
const when = (condition, value) => ({
  "Fn::If": [condition, value, ref("AWS::NoValue")],
});
const nonempty = (name) => ({ "Fn::Not": [{ "Fn::Equals": [ref(name), ""] }] });

export function installTemplate({
  region,
  bucket,
  key,
  objectVersion,
  version,
}) {
  if (
    !/^[a-z]{2}-[a-z]+-\d$/.test(region) ||
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) ||
    !key.startsWith("releases/") ||
    !objectVersion ||
    !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)
  )
    throw new Error(
      "Valid regional release artifacts and an immutable S3 object version are required.",
    );
  const origin = {
    "Fn::If": [
      "HasCustomOrigin",
      ref("AppOrigin"),
      sub("https://${Api}.execute-api.${AWS::Region}.${AWS::URLSuffix}"),
    ],
  };
  return {
    AWSTemplateFormatVersion: "2010-09-09",
    Description: `Keylo ${version}: self-hosted translations, protected first-run setup. Creates billable AWS resources. Single organization; no SaaS services.`,
    Metadata: {
      // Optional SSO ARN is empty for local installs. W1030 cannot infer that
      // the SSO rules require it before the conditional IAM policy is emitted.
      "cfn-lint": { config: { ignore_checks: ["W1030"] } },
      "AWS::CloudFormation::Interface": {
        ParameterGroups: [
          {
            Label: { default: "Installation" },
            Parameters: ["AuthMode", "AppOrigin"],
          },
          {
            Label: {
              default:
                "Optional OIDC / SAML — configure only for the selected SSO mode",
            },
            Parameters: [
              "AppSecretsArn",
              "OktaIssuer",
              "OktaClientId",
              "SamlEntryPoint",
              "SamlIdpIssuer",
              "SamlSpEntityId",
              "SecretsRevision",
              "SsoProvisioningMode",
              "ScimSecretArn",
              "ReconciliationSecretArn",
            ],
          },
          {
            Label: { default: "Optional capacity" },
            Parameters: ["ReservedConcurrency"],
          },
        ],
        ParameterLabels: {
          AuthMode: {
            default:
              "Sign-in method (local accounts recommended for first install)",
          },
          AppOrigin: {
            default:
              "Custom HTTPS origin (optional; leave empty for automatic AWS URL)",
          },
        },
      },
      KeyloRelease: { version, region, artifact: key },
    },
    Parameters: {
      SsoProvisioningMode: {
        Type: "String",
        Default: "jit",
        AllowedValues: ["jit", "scim"],
        Description:
          "JIT learns users at sign-in; SCIM requires pre-provisioning and current pushed groups.",
      },
      ScimSecretArn: {
        Type: "String",
        Default: "",
        AllowedPattern:
          "^$|arn:aws:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:.+",
        Description:
          "SCIM-only existing secret containing a plain random provisioning token (32+ characters).",
      },
      ReconciliationSecretArn: {
        Type: "String",
        Default: "",
        AllowedPattern:
          "^$|arn:aws:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:.+",
        Description:
          "Optional Okta reconciliation JSON secret: origin, appId, apiToken. Enables the five-minute scheduled job.",
      },
      ReservedConcurrency: {
        Type: "Number",
        Default: 0,
        MinValue: 0,
        MaxValue: 1000,
        Description:
          "0 uses account-default concurrency so fresh AWS accounts can install. Set a positive per-function limit after checking your regional quota.",
      },
      AuthMode: {
        Type: "String",
        Default: "local",
        AllowedValues: ["local", "okta", "saml"],
        Description:
          "Local accounts include protected web setup. SSO requires your IdP configuration and existing secret.",
      },
      AppOrigin: {
        Type: "String",
        Default: "",
        AllowedPattern: "^$|https://[a-zA-Z0-9.-]+(?::[0-9]+)?",
        Description:
          "Leave empty for the generated API Gateway HTTPS URL. Custom DNS/TLS mapping is configured separately.",
      },
      AppSecretsArn: {
        Type: "String",
        Default: "",
        AllowedPattern:
          "^$|arn:aws:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:.+",
        Description:
          "Existing SSO secret ARN in this region. OIDC: OKTA_CLIENT_SECRET/SESSION_SECRET. SAML: SAML_IDP_CERT/SAML_SP_PRIVATE_KEY/SAML_SP_CERT.",
      },
      OktaIssuer: {
        Type: "String",
        Default: "",
        AllowedPattern: "^$|https://[^\\s]+",
      },
      OktaClientId: { Type: "String", Default: "" },
      SamlEntryPoint: {
        Type: "String",
        Default: "",
        AllowedPattern: "^$|https://[^\\s]+",
      },
      SamlIdpIssuer: { Type: "String", Default: "" },
      SamlSpEntityId: {
        Type: "String",
        Default: "",
        Description: "Defaults to the application's /auth/saml/metadata URL.",
      },
      SecretsRevision: {
        Type: "String",
        Default: "1",
        Description:
          "Increment after rotating SSO secrets to replace warm execution environments.",
      },
    },
    Rules: {
      ScimConfiguration: {
        RuleCondition: { "Fn::Equals": [ref("SsoProvisioningMode"), "scim"] },
        Assertions: [
          {
            Assert: {
              "Fn::Or": [
                { "Fn::Equals": [ref("AuthMode"), "okta"] },
                { "Fn::Equals": [ref("AuthMode"), "saml"] },
              ],
            },
            AssertDescription: "SCIM requires OIDC or SAML SSO.",
          },
          {
            Assert: nonempty("ScimSecretArn"),
            AssertDescription:
              "SCIM requires an existing provisioning credential secret.",
          },
        ],
      },
      ReconciliationConfiguration: {
        RuleCondition: nonempty("ReconciliationSecretArn"),
        Assertions: [
          {
            Assert: {
              "Fn::Or": [
                { "Fn::Equals": [ref("AuthMode"), "okta"] },
                { "Fn::Equals": [ref("AuthMode"), "saml"] },
              ],
            },
            AssertDescription: "Reconciliation requires SSO.",
          },
        ],
      },
      OktaConfiguration: {
        RuleCondition: { "Fn::Equals": [ref("AuthMode"), "okta"] },
        Assertions: ["OktaIssuer", "OktaClientId", "AppSecretsArn"].map(
          (name) => ({
            Assert: nonempty(name),
            AssertDescription: `${name} is required for OIDC.`,
          }),
        ),
      },
      SamlConfiguration: {
        RuleCondition: { "Fn::Equals": [ref("AuthMode"), "saml"] },
        Assertions: ["SamlEntryPoint", "SamlIdpIssuer", "AppSecretsArn"].map(
          (name) => ({
            Assert: nonempty(name),
            AssertDescription: `${name} is required for SAML.`,
          }),
        ),
      },
    },
    Mappings: {
      ReleaseArtifacts: {
        [region]: { Bucket: bucket, Key: key, ObjectVersion: objectVersion },
      },
    },
    Conditions: {
      UseScim: { "Fn::Equals": [ref("SsoProvisioningMode"), "scim"] },
      HasSsoReconciliation: nonempty("ReconciliationSecretArn"),
      HasReservedConcurrency: {
        "Fn::Not": [{ "Fn::Equals": [ref("ReservedConcurrency"), 0] }],
      },
      UseLocal: { "Fn::Equals": [ref("AuthMode"), "local"] },
      UseOkta: { "Fn::Equals": [ref("AuthMode"), "okta"] },
      UseSaml: { "Fn::Equals": [ref("AuthMode"), "saml"] },
      HasCustomOrigin: nonempty("AppOrigin"),
      HasSamlSpEntityId: nonempty("SamlSpEntityId"),
    },
    Resources: {
      ...snapshotResources(),
      Data: {
        Type: "AWS::DynamoDB::Table",
        DeletionPolicy: "Retain",
        UpdateReplacePolicy: "Retain",
        Properties: {
          BillingMode: "PAY_PER_REQUEST",
          DeletionProtectionEnabled: true,
          AttributeDefinitions: [
            { AttributeName: "pk", AttributeType: "S" },
            { AttributeName: "sk", AttributeType: "S" },
          ],
          KeySchema: [
            { AttributeName: "pk", KeyType: "HASH" },
            { AttributeName: "sk", KeyType: "RANGE" },
          ],
          SSESpecification: { SSEEnabled: true },
          PointInTimeRecoverySpecification: {
            PointInTimeRecoveryEnabled: true,
          },
          TimeToLiveSpecification: { AttributeName: "ttl", Enabled: true },
        },
      },
      InstallSecret: {
        Type: "AWS::SecretsManager::Secret",
        Condition: "UseLocal",
        Properties: {
          Description:
            "Keylo first administrator setup. Unusable after initialization. Retrieve token from your AWS account; never put it in a URL.",
          GenerateSecretString: {
            SecretStringTemplate: '{"purpose":"keylo-install-v1"}',
            GenerateStringKey: "token",
            PasswordLength: 48,
            ExcludePunctuation: true,
            IncludeSpace: false,
            RequireEachIncludedType: false,
          },
        },
      },
      AppLogGroup: {
        Type: "AWS::Logs::LogGroup",
        Properties: { RetentionInDays: 14 },
      },
      ApiLogGroup: {
        Type: "AWS::Logs::LogGroup",
        Properties: { RetentionInDays: 14 },
      },
      AppRole: {
        Type: "AWS::IAM::Role",
        Properties: {
          AssumeRolePolicyDocument: {
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Principal: { Service: "lambda.amazonaws.com" },
                Action: "sts:AssumeRole",
              },
            ],
          },
          Policies: [
            {
              PolicyName: "KeyloDataAndLogs",
              PolicyDocument: {
                Version: "2012-10-17",
                Statement: [
                  {
                    Effect: "Allow",
                    Action: [
                      "dynamodb:GetItem",
                      "dynamodb:Query",
                      "dynamodb:PutItem",
                      "dynamodb:DeleteItem",
                      "dynamodb:ConditionCheckItem",
                    ],
                    Resource: attr("Data", "Arn"),
                  },
                  {
                    Effect: "Allow",
                    Action: "secretsmanager:GetSecretValue",
                    Resource: ref("SnapshotJobSecret"),
                  },
                  {
                    Effect: "Allow",
                    Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
                    Resource: attr("AppLogGroup", "Arn"),
                  },
                ],
              },
            },
            when("UseLocal", {
              PolicyName: "KeyloInstallSecret",
              PolicyDocument: {
                Version: "2012-10-17",
                Statement: [
                  {
                    Effect: "Allow",
                    Action: "secretsmanager:GetSecretValue",
                    Resource: ref("InstallSecret"),
                  },
                ],
              },
            }),
            when("UseSaml", {
              PolicyName: "KeyloSamlSecret",
              PolicyDocument: {
                Version: "2012-10-17",
                Statement: [
                  {
                    Effect: "Allow",
                    Action: "secretsmanager:GetSecretValue",
                    Resource: ref("AppSecretsArn"),
                  },
                ],
              },
            }),
            when("UseScim", {
              PolicyName: "KeyloScimSecret",
              PolicyDocument: {
                Version: "2012-10-17",
                Statement: [
                  {
                    Effect: "Allow",
                    Action: "secretsmanager:GetSecretValue",
                    Resource: ref("ScimSecretArn"),
                  },
                ],
              },
            }),
            when("HasSsoReconciliation", {
              PolicyName: "KeyloReconciliationSecret",
              PolicyDocument: {
                Version: "2012-10-17",
                Statement: [
                  {
                    Effect: "Allow",
                    Action: "secretsmanager:GetSecretValue",
                    Resource: ref("ReconciliationSecretArn"),
                  },
                ],
              },
            }),
          ],
        },
      },
      // Api is deliberately independent of App: App can derive its trusted origin
      // from the API ID without a CloudFormation circular dependency.
      Api: {
        Type: "AWS::ApiGatewayV2::Api",
        Properties: {
          ProtocolType: "HTTP",
          Name: sub("${AWS::StackName}-keylo"),
        },
      },
      App: {
        Type: "AWS::Lambda::Function",
        Properties: {
          Runtime: "nodejs24.x",
          Handler: "run.sh",
          Architectures: ["x86_64"],
          MemorySize: 1024,
          Timeout: 28,
          ReservedConcurrentExecutions: when(
            "HasReservedConcurrency",
            ref("ReservedConcurrency"),
          ),
          Role: attr("AppRole", "Arn"),
          LoggingConfig: { LogGroup: ref("AppLogGroup") },
          Code: Object.fromEntries(
            [
              ["S3Bucket", "Bucket"],
              ["S3Key", "Key"],
              ["S3ObjectVersion", "ObjectVersion"],
            ].map(([field, item]) => [
              field,
              {
                "Fn::FindInMap": ["ReleaseArtifacts", ref("AWS::Region"), item],
              },
            ]),
          ),
          Layers: [
            sub(
              "arn:${AWS::Partition}:lambda:${AWS::Region}:753240598075:layer:LambdaAdapterLayerX86:30",
            ),
          ],
          Environment: {
            Variables: {
              NODE_ENV: "production",
              HOST: "0.0.0.0",
              PORT: "8080",
              AWS_LAMBDA_EXEC_WRAPPER: "/opt/bootstrap",
              AWS_LWA_PORT: "8080",
              AWS_LWA_READINESS_CHECK_PATH: "/api/health",
              AWS_LWA_READINESS_CHECK_HEALTHY_STATUS: "200",
              AWS_LWA_ASYNC_INIT: "true",
              APP_ORIGIN: origin,
              AUTH_MODE: ref("AuthMode"),
              SSO_PROVISIONING_MODE: ref("SsoProvisioningMode"),
              SSO_SCIM_SECRET_ARN: when("UseScim", ref("ScimSecretArn")),
              SSO_RECONCILE_SECRET_ARN: when(
                "HasSsoReconciliation",
                ref("ReconciliationSecretArn"),
              ),
              STORAGE_DRIVER: "dynamodb",
              DYNAMODB_TABLE: ref("Data"),
              KEYLO_VERSION: version,
              KEYLO_SNAPSHOT_JOB_SECRET_ARN: ref("SnapshotJobSecret"),
              KEYLO_INSTALL_SECRET_ARN: when("UseLocal", ref("InstallSecret")),
              SAML_ENTRY_POINT: when("UseSaml", ref("SamlEntryPoint")),
              SAML_IDP_ISSUER: when("UseSaml", ref("SamlIdpIssuer")),
              SAML_SP_ENTITY_ID: when(
                "HasSamlSpEntityId",
                ref("SamlSpEntityId"),
              ),
              SAML_SECRETS_ARN: when("UseSaml", ref("AppSecretsArn")),
              OKTA_ISSUER: when("UseOkta", ref("OktaIssuer")),
              OKTA_CLIENT_ID: when("UseOkta", ref("OktaClientId")),
              OKTA_CLIENT_SECRET: when(
                "UseOkta",
                sub(
                  "{{resolve:secretsmanager:${AppSecretsArn}:SecretString:OKTA_CLIENT_SECRET}}",
                ),
              ),
              SESSION_SECRET: when(
                "UseOkta",
                sub(
                  "{{resolve:secretsmanager:${AppSecretsArn}:SecretString:SESSION_SECRET}}",
                ),
              ),
              KEYLO_SECRETS_REVISION: ref("SecretsRevision"),
            },
          },
        },
      },
      Integration: {
        Type: "AWS::ApiGatewayV2::Integration",
        Properties: {
          ApiId: ref("Api"),
          IntegrationType: "AWS_PROXY",
          IntegrationUri: attr("App", "Arn"),
          PayloadFormatVersion: "2.0",
          TimeoutInMillis: 28000,
        },
      },
      Route: {
        Type: "AWS::ApiGatewayV2::Route",
        Properties: {
          ApiId: ref("Api"),
          RouteKey: "$default",
          Target: { "Fn::Join": ["/", ["integrations", ref("Integration")]] },
        },
      },
      Stage: {
        Type: "AWS::ApiGatewayV2::Stage",
        DependsOn: "Route",
        Properties: {
          ApiId: ref("Api"),
          StageName: "$default",
          AutoDeploy: true,
          DefaultRouteSettings: {
            ThrottlingBurstLimit: 40,
            ThrottlingRateLimit: 20,
          },
          AccessLogSettings: {
            DestinationArn: attr("ApiLogGroup", "Arn"),
            Format:
              '{"requestId":"$context.requestId","route":"$context.routeKey","status":"$context.status","bytes":"$context.responseLength"}',
          },
        },
      },
      InvokePermission: {
        Type: "AWS::Lambda::Permission",
        Properties: {
          FunctionName: ref("App"),
          Action: "lambda:InvokeFunction",
          Principal: "apigateway.amazonaws.com",
          SourceAccount: ref("AWS::AccountId"),
          SourceArn: sub(
            "arn:${AWS::Partition}:execute-api:${AWS::Region}:${AWS::AccountId}:${Api}/*",
          ),
        },
      },
    },
    Outputs: {
      Url: {
        Description:
          "Open Keylo. For local accounts, the first visit opens protected setup.",
        Value: origin,
      },
      SetupUrl: {
        Condition: "UseLocal",
        Description:
          "Complete protected first-run setup. Requires the token retrieved from SetupSecretConsole.",
        Value: { "Fn::Join": ["", [origin, "/auth/install"]] },
      },
      SetupSecretArn: {
        Condition: "UseLocal",
        Description:
          "Retrieve this secret's token value in your AWS account. It cannot initialize a second admin after setup.",
        Value: ref("InstallSecret"),
      },
      SetupSecretConsole: {
        Condition: "UseLocal",
        Description:
          "Open AWS Secrets Manager, find SetupSecretArn, retrieve its value, and copy the token field.",
        Value: sub(
          "https://${AWS::Region}.console.aws.amazon.com/secretsmanager/home?region=${AWS::Region}",
        ),
      },
      DataTable: {
        Value: ref("Data"),
        Description:
          "Retained on stack deletion; DynamoDB deletion protection and PITR enabled.",
      },
      Version: { Value: version },
    },
  };
}
