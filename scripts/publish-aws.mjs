import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify, parseArgs } from "node:util";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { stringify } from "yaml";
import { installTemplate } from "../infra/install-template.mjs";

const execute = promisify(execFile);
const hash = (data) => createHash("sha256").update(data).digest("hex");
export function launchUrl(region, templateUrl) {
  const target = new URL(templateUrl);
  if (
    target.protocol !== "https:" ||
    target.username ||
    target.password ||
    !(
      (target.hostname.endsWith(`.s3.${region}.amazonaws.com`) &&
        target.pathname.startsWith("/releases/")) ||
      (target.hostname === `s3.${region}.amazonaws.com` &&
        /^\/[a-z0-9][a-z0-9.-]+\/releases\//.test(target.pathname))
    )
  )
    throw new Error("A regional S3 release template URL is required.");
  const params = new URLSearchParams({
    templateURL: target.href,
    stackName: "kieli",
    param_AuthMode: "local",
  });
  return `https://${region}.console.aws.amazon.com/cloudformation/home?region=${region}#/stacks/create/review?${params}`;
}
export async function validateRelease(directory) {
  const manifest = JSON.parse(
    await readFile(join(directory, "release.json"), "utf8"),
  );
  if (
    manifest.publishable !== true ||
    manifest.platform !== "linux" ||
    manifest.architecture !== "x64" ||
    !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(manifest.version) ||
    !/^[a-f0-9]{64}$/.test(manifest.sha256) ||
    manifest.file !==
      `kieli-${manifest.version}-${manifest.sha256.slice(0, 16)}.zip`
  )
    throw new Error(
      "Only a verified Linux x64 release package can be published.",
    );
  const archive = await readFile(join(directory, manifest.file));
  if (archive.length !== manifest.bytes || hash(archive) !== manifest.sha256)
    throw new Error("Release checksum verification failed.");
  return manifest;
}
export async function publishAws({
  directory,
  region,
  bucket,
  aws = async (args) => {
    const result = await execute(
      "aws",
      [...args, "--region", region, "--output", "json"],
      { maxBuffer: 1024 * 1024 },
    );
    return result.stdout.trim() ? JSON.parse(result.stdout) : {};
  },
}) {
  if (
    !/^[a-z]{2}-[a-z]+-\d$/.test(region) ||
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)
  )
    throw new Error("A commercial AWS region and S3 bucket name are required.");
  const manifest = await validateRelease(directory);
  const prefix = `releases/${manifest.version}`;
  async function put(file, key, type) {
    const checksum = hash(await readFile(file));
    try {
      const response = await aws([
        "s3api",
        "put-object",
        "--bucket",
        bucket,
        "--key",
        key,
        "--body",
        file,
        "--if-none-match",
        "*",
        "--content-type",
        type,
        "--server-side-encryption",
        "AES256",
        "--cache-control",
        "public,max-age=31536000,immutable",
        "--metadata",
        `sha256=${checksum}`,
      ]);
      if (!response.VersionId || response.VersionId === "null")
        throw new Error("Release bucket versioning must be enabled.");
      return response.VersionId;
    } catch (error) {
      if (!/PreconditionFailed|412/.test(String(error.stderr ?? error.message)))
        throw error;
      const existing = await aws([
        "s3api",
        "head-object",
        "--bucket",
        bucket,
        "--key",
        key,
      ]);
      if (
        existing.Metadata?.sha256 !== checksum ||
        !existing.VersionId ||
        existing.VersionId === "null"
      )
        throw new Error(
          "Published release differs. Publish a new version; existing releases are immutable.",
        );
      return existing.VersionId;
    }
  }
  const key = `${prefix}/${manifest.file}`;
  const objectVersion = await put(
    join(directory, manifest.file),
    key,
    "application/zip",
  );
  const template = installTemplate({
    region,
    bucket,
    key,
    objectVersion,
    version: manifest.version,
  });
  const templateFile = join(directory, `install-${region}.yaml`);
  await writeFile(
    templateFile,
    stringify(template, { aliasDuplicateObjects: false }),
  );
  await aws([
    "cloudformation",
    "validate-template",
    "--template-body",
    `file://${resolve(templateFile)}`,
  ]);
  const templateKey = `${prefix}/install.yaml`;
  const templateVersion = await put(
    templateFile,
    templateKey,
    "application/yaml",
  );
  const templateUrl = `https://s3.${region}.amazonaws.com/${bucket}/${templateKey}?versionId=${encodeURIComponent(templateVersion)}`;
  const links = {
    version: manifest.version,
    region,
    sha256: manifest.sha256,
    templateUrl,
    launchUrl: launchUrl(region, templateUrl),
  };
  const manifestFile = join(directory, `published-${region}.json`);
  await writeFile(
    manifestFile,
    JSON.stringify({ ...manifest, ...links, objectVersion }, null, 2) + "\n",
  );
  await put(manifestFile, `${prefix}/release.json`, "application/json");
  await writeFile(
    join(directory, `launch-${region}.md`),
    `# Kieli ${manifest.version}\n\n[Deploy Kieli in ${region}](${links.launchUrl})\n\n[Review template](${templateUrl})\n\nSHA-256: \`${manifest.sha256}\`\n\nCreates billable resources in your AWS account. Local accounts use protected first-run setup.\n`,
  );
  return links;
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const { values } = parseArgs({
    options: {
      directory: { type: "string", default: ".aws-release" },
      region: { type: "string" },
      bucket: { type: "string" },
    },
  });
  console.log(
    JSON.stringify(
      await publishAws({
        directory: resolve(values.directory),
        region: values.region,
        bucket: values.bucket,
      }),
      null,
      2,
    ),
  );
}
