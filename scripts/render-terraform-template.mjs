import { mkdir, writeFile } from "node:fs/promises";
import { installTemplate } from "../infra/install-template.mjs";
// Terraform replaces this mapping with operator-supplied immutable artifact coordinates.
const template = installTemplate({
  region: "eu-west-1",
  bucket: "kieli-placeholder-artifacts",
  key: "releases/placeholder.zip",
  objectVersion: "PLACEHOLDER",
  version: "0.1.0",
});
const destination = new URL("../infra/terraform/.generated/", import.meta.url);
await mkdir(destination, { recursive: true });
await writeFile(
  new URL("install.json", destination),
  JSON.stringify(template, null, 2) + "\n",
);
console.log(
  "Rendered infra/terraform/.generated/install.json; no AWS actions performed.",
);
