import { writeFile } from "node:fs/promises";
import { stringify } from "yaml";
import { installTemplate } from "../infra/install-template.mjs";
// Schema/lint fixture only: no launch link or deployable artifact is implied.
const template = installTemplate({
  region: "eu-west-1",
  bucket: "kieli-example-artifacts",
  key: "releases/0.1.0/kieli-example.zip",
  objectVersion: "EXAMPLE_NOT_PUBLISHED",
  version: "0.1.0",
});
await writeFile(
  process.argv[2] ?? ".aws-release/install-example.yaml",
  stringify(template, { aliasDuplicateObjects: false }),
);
