import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parse } from "yaml";
import { installTemplate } from "../infra/install-template.mjs";
import {
  launchUrl,
  publishAws,
  validateRelease,
} from "../scripts/publish-aws.mjs";

const parameters = {
  region: "eu-west-1",
  bucket: "kieli-release-fixture",
  key: "releases/0.1.0/kieli.zip",
  objectVersion: "immutable-version",
  version: "0.1.0",
};
const template = () => installTemplate(parameters);
function resourceReferences(value, resources) {
  if (!value || typeof value !== "object") return [];
  const refs = [];
  if (value.Ref && resources[value.Ref]) refs.push(value.Ref);
  if (value["Fn::GetAtt"]) refs.push(value["Fn::GetAtt"][0]);
  if (typeof value["Fn::Sub"] === "string")
    for (const match of value["Fn::Sub"].matchAll(
      /\$\{([A-Za-z0-9]+)(?:\.[^}]+)?\}/g,
    ))
      if (resources[match[1]]) refs.push(match[1]);
  for (const child of Object.values(value))
    if (typeof child === "object")
      refs.push(...resourceReferences(child, resources));
  return refs;
}
test("installation template has no dependency cycle and derives a trusted origin", () => {
  const t = template();
  const visiting = new Set(),
    visited = new Set();
  function visit(name) {
    if (visited.has(name)) return;
    assert.ok(!visiting.has(name), `Circular dependency at ${name}`);
    visiting.add(name);
    const resource = t.Resources[name];
    const dependencies = resourceReferences(resource, t.Resources);
    if (resource.DependsOn) dependencies.push(...[resource.DependsOn].flat());
    dependencies.forEach(visit);
    visiting.delete(name);
    visited.add(name);
  }
  Object.keys(t.Resources).forEach(visit);
  assert.equal(t.Parameters.AppOrigin.Default, "");
  assert.deepEqual(
    t.Resources.App.Properties.Environment.Variables.APP_ORIGIN["Fn::If"][2],
    {
      "Fn::Sub": "https://${Api}.execute-api.${AWS::Region}.${AWS::URLSuffix}",
    },
  );
  assert.equal(t.Resources.Route.Properties.RouteKey, "$default");
  assert.equal(t.Resources.App.Properties.Runtime, "nodejs24.x");
});
test("customer stack retains data, pins code versions, limits IAM and never outputs setup credentials", () => {
  const t = template(),
    r = t.Resources;
  assert.equal(r.Data.DeletionPolicy, "Retain");
  assert.equal(r.Data.UpdateReplacePolicy, "Retain");
  assert.equal(r.Data.Properties.DeletionProtectionEnabled, true);
  assert.equal(
    r.Data.Properties.PointInTimeRecoverySpecification
      .PointInTimeRecoveryEnabled,
    true,
  );
  assert.equal(
    t.Mappings.ReleaseArtifacts[parameters.region].ObjectVersion,
    parameters.objectVersion,
  );
  assert.equal(
    r.InstallSecret.Properties.GenerateSecretString.PasswordLength,
    48,
  );
  assert.ok(!JSON.stringify(t.Outputs).includes("resolve:secretsmanager"));
  assert.deepEqual(
    r.App.Properties.Environment.Variables.KIELI_INSTALL_SECRET_ARN,
    {
      "Fn::If": ["UseLocal", { Ref: "InstallSecret" }, { Ref: "AWS::NoValue" }],
    },
  );
  assert.ok(!JSON.stringify(r.AppRole).includes('"Action":"*"'));
  assert.ok(!JSON.stringify(r.AppRole).includes('"Resource":"*"'));
  assert.ok(
    !Object.values(r).some((resource) =>
      /Vpc|NatGateway|EC2::/.test(resource.Type),
    ),
  );
  assert.ok(
    !JSON.stringify(r.Stage.Properties.AccessLogSettings).includes(
      "authorization",
    ),
  );
});
test("launch links preserve encoded template versions and never carry credentials", () => {
  const target =
    "https://kieli-release-fixture.s3.eu-west-1.amazonaws.com/releases/0.1.0/install.yaml?versionId=abc%2Bxyz";
  const url = new URL(launchUrl("eu-west-1", target));
  const query = new URLSearchParams(url.hash.split("?")[1]);
  assert.equal(query.get("templateURL"), target);
  assert.equal(query.get("param_AuthMode"), "local");
  assert.equal(query.get("stackName"), "kieli");
  assert.throws(() =>
    launchUrl("eu-west-1", "https://evil.example/install.yaml"),
  );
});
test("publishing validates checksums, pins object versions and is immutable on retries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kieli-release-test-"));
  try {
    const bytes = Buffer.from("synthetic test archive");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const manifest = {
      version: "0.1.0",
      sha256,
      file: `kieli-0.1.0-${sha256.slice(0, 16)}.zip`,
      bytes: bytes.length,
      platform: "linux",
      architecture: "x64",
      publishable: true,
    };
    await writeFile(join(directory, manifest.file), bytes);
    await writeFile(join(directory, "release.json"), JSON.stringify(manifest));
    const objects = new Map();
    const aws = async (args) => {
      if (args[0] === "cloudformation") return {};
      const key = args[args.indexOf("--key") + 1];
      if (args[1] === "head-object") return objects.get(key);
      assert.ok(args.includes("--if-none-match"));
      if (objects.has(key)) {
        const error = new Error("PreconditionFailed");
        throw error;
      }
      const data = await readFile(args[args.indexOf("--body") + 1]);
      const metadata = args[args.indexOf("--metadata") + 1].split("=")[1];
      const object = {
        VersionId: `version-${objects.size}`,
        Metadata: { sha256: metadata },
        data,
      };
      objects.set(key, object);
      return object;
    };
    const options = {
      directory,
      region: parameters.region,
      bucket: parameters.bucket,
      aws,
    };
    const first = await publishAws(options);
    const second = await publishAws(options);
    assert.deepEqual(first, second);
    const published = parse(
      await readFile(join(directory, "install-eu-west-1.yaml"), "utf8"),
    );
    assert.equal(
      published.Mappings.ReleaseArtifacts[parameters.region].ObjectVersion,
      "version-0",
    );
    await writeFile(join(directory, manifest.file), "tampered");
    await assert.rejects(validateRelease(directory), /checksum/);
    await writeFile(
      join(directory, "release.json"),
      JSON.stringify({ ...manifest, publishable: false }),
    );
    await assert.rejects(validateRelease(directory), /Linux x64/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("release workflow keeps AWS publishing optional and separates privileged publishing", async () => {
  const workflow = parse(
    await readFile(
      new URL("../.github/workflows/aws-release.yml", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(workflow.jobs.publish.environment, "aws-release");
  assert.equal(workflow.jobs.publish.permissions["id-token"], "write");
  assert.equal(workflow.jobs.package.permissions, undefined);
  assert.equal(
    workflow.jobs.publish.if,
    "needs.package.outputs.publish == 'true'",
  );
});

test("fresh-account installs do not require a reserved concurrency allocation, and optional SSO secrets are guarded", () => {
  const t = template();
  assert.equal(t.Parameters.ReservedConcurrency.Default, 0);
  assert.deepEqual(t.Resources.App.Properties.ReservedConcurrentExecutions, {
    "Fn::If": [
      "HasReservedConcurrency",
      { Ref: "ReservedConcurrency" },
      { Ref: "AWS::NoValue" },
    ],
  });
  const saml = t.Resources.AppRole.Properties.Policies[2]["Fn::If"];
  assert.equal(saml[0], "UseSaml");
  assert.deepEqual(saml[1].PolicyDocument.Statement[0].Resource, {
    Ref: "AppSecretsArn",
  });
  assert.ok(
    t.Rules.SamlConfiguration.Assertions.some((assertion) =>
      JSON.stringify(assertion.Assert).includes('"Ref":"AppSecretsArn"'),
    ),
  );
  assert.ok(
    t.Rules.OktaConfiguration.Assertions.some((assertion) =>
      JSON.stringify(assertion.Assert).includes('"Ref":"AppSecretsArn"'),
    ),
  );
});

test("automatic snapshots use a scoped secret, isolated runner and bounded EventBridge retries", () => {
  const r = template().Resources;
  assert.equal(
    r.SnapshotSchedule.Properties.ScheduleExpression,
    "rate(5 minutes)",
  );
  assert.equal(
    r.SnapshotSchedule.Properties.Targets[0].RetryPolicy.MaximumRetryAttempts,
    2,
  );
  assert.deepEqual(
    r.App.Properties.Environment.Variables.KIELI_SNAPSHOT_JOB_SECRET_ARN,
    { Ref: "SnapshotJobSecret" },
  );
  assert.ok(JSON.stringify(r.AppRole).includes("SnapshotJobSecret"));
  assert.ok(!JSON.stringify(r.SnapshotRunnerRole).includes('"Resource":"*"'));
  assert.ok(!JSON.stringify(r.SnapshotRunnerRole).includes("dynamodb:"));
  assert.match(r.SnapshotRunner.Properties.Code.ZipFile, /FunctionError/);
  assert.match(r.SnapshotRunner.Properties.Code.ZipFile, /partial-failure/);
  assert.ok(!r.SnapshotRunner.Properties.Code.ZipFile.includes("console.log"));
});

test("SSO provisioning and reconciliation are opt-in and use exact secret resources in both templates", async () => {
  const t = template();
  assert.equal(t.Parameters.SsoProvisioningMode.Default, "jit");
  assert.deepEqual(t.Parameters.SsoProvisioningMode.AllowedValues, [
    "jit",
    "scim",
  ]);
  assert.equal(t.Parameters.ScimSecretArn.Default, "");
  assert.equal(t.Parameters.ReconciliationSecretArn.Default, "");
  const policies = JSON.stringify(t.Resources.AppRole.Properties.Policies);
  assert.ok(policies.includes("ScimSecretArn"));
  assert.ok(policies.includes("ReconciliationSecretArn"));
  assert.ok(!policies.includes('"Resource":"*"'));
  assert.ok(JSON.stringify(t.Rules).includes("SsoProvisioningMode"));
  assert.ok(JSON.stringify(t.Rules).includes("ReconciliationSecretArn"));
  assert.deepEqual(
    t.Resources.SnapshotRunner.Properties.Environment.Variables
      .RECONCILE_ENABLED,
    { "Fn::If": ["HasSsoReconciliation", "true", "false"] },
  );
  assert.match(
    t.Resources.SnapshotRunner.Properties.Code.ZipFile,
    /tasks\/identities/,
  );
  assert.equal(t.Resources.App.Properties.Runtime, "nodejs24.x");
  assert.equal(t.Resources.App.Properties.Handler, "run.sh");
  assert.ok(!JSON.stringify(t).includes('"PackageType":"Image"'));
});
