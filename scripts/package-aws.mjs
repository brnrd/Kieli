import { nodeFileTrace } from "@vercel/nft";
import { zipSync } from "fflate";
import { createHash } from "node:crypto";
import {
  readFile,
  writeFile,
  mkdir,
  mkdtemp,
  copyFile,
  readdir,
  stat,
  chmod,
} from "node:fs/promises";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const root = fileURLToPath(new URL("../", import.meta.url));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
export function releasePlatform() {
  return (
    process.platform === "linux" &&
    process.arch === "x64" &&
    !!process.report.getReport().header.glibcVersionRuntime
  );
}
export async function packageAws({
  out = join(root, ".aws-release"),
  localTest = false,
} = {}) {
  if (!localTest && !releasePlatform())
    throw new Error(
      "AWS releases must be packaged on Linux x64 with glibc. Use the Linux release workflow; --local-test builds a non-publishable QA package.",
    );
  const destination = resolve(out);
  await mkdir(destination, { recursive: true });
  const stage = await mkdtemp(join(destination, "stage-"));
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const traced = await nodeFileTrace([join(root, "dist/server/entry.mjs")], {
    base: root,
  });
  // These optional platform probes are expected in native loaders. Every other
  // tracing problem fails packaging instead of silently omitting dependencies.
  const optionalWarning = (message) =>
    /^Failed to resolve dependency "(?:\.\/argon2\.[^"/]+\.node|\.\/argon2\.wasi\.cjs|@node-rs\/argon2[^"\n]*|@img\/sharp-[^"\n]*|supports-color)":/.test(
      message,
    ) ||
    /^Failed to parse .*\/node_modules\/@img\/sharp-libvips-[^\n]+\.(?:dylib|so(?:\.\d+)*) as (?:script|module):/.test(
      message,
    );
  const unexpected = [...traced.warnings].filter(
    (warning) => !optionalWarning(warning.message),
  );
  if (unexpected.length)
    throw new Error(
      `Dependency tracing failed:\n${unexpected.map((warning) => warning.message.split("\n")[0]).join("\n")}`,
    );
  const files = new Set(traced.fileList);
  for (const file of [...files]) {
    if (
      !/^(?:dist\/server\/|node_modules\/|package\.json$)/.test(file) ||
      file.split("/").includes("..")
    )
      throw new Error(`Unexpected file in runtime trace: ${file}`);
  }
  const notices = [];
  for (const file of [...files].filter(
    (file) =>
      file.startsWith("node_modules/") && file.endsWith("/package.json"),
  )) {
    const folder = dirname(file);
    const info = JSON.parse(await readFile(join(root, file), "utf8"));
    notices.push(
      `${info.name ?? folder} ${info.version ?? ""}: ${typeof info.license === "string" ? info.license : "See package license"}`,
    );
    for (const name of await readdir(join(root, folder)))
      if (
        /^(?:licen[cs]e|notice|copying)(?:[._-].*)?$/i.test(name) &&
        (await stat(join(root, folder, name))).isFile()
      )
        files.add(join(folder, name));
  }
  for (const file of files) {
    const target = join(stage, file);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(root, file), target);
  }
  async function copyTree(from, into) {
    await mkdir(into, { recursive: true });
    for (const item of await readdir(from, { withFileTypes: true })) {
      if (item.isSymbolicLink())
        throw new Error("Static assets must not contain symlinks.");
      if (item.isDirectory())
        await copyTree(join(from, item.name), join(into, item.name));
      else await copyFile(join(from, item.name), join(into, item.name));
    }
  }
  await copyTree(join(root, "dist/client"), join(stage, "dist/client"));
  await copyFile(join(root, "infra/run.sh"), join(stage, "run.sh"));
  await chmod(join(stage, "run.sh"), 0o755);
  await copyFile(join(root, "LICENSE"), join(stage, "LICENSE"));
  await writeFile(
    join(stage, "THIRD_PARTY_NOTICES.txt"),
    notices.sort().join("\n") + "\n",
  );
  if (!localTest) {
    const native = await readFile(
      join(
        stage,
        "node_modules/@node-rs/argon2-linux-x64-gnu/argon2.linux-x64-gnu.node",
      ),
    );
    if (
      native.subarray(0, 4).toString("hex") !== "7f454c46" ||
      native.readUInt16LE(18) !== 62
    )
      throw new Error("The packaged Argon2 binary is not Linux x64 ELF.");
  }
  const archiveFiles = {};
  let uncompressedBytes = 0;
  async function collect(folder) {
    for (const item of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, item.name);
      if (item.isDirectory()) await collect(path);
      else {
        const bytes = await readFile(path);
        uncompressedBytes += bytes.length;
        archiveFiles[relative(stage, path).replaceAll("\\", "/")] = [
          bytes,
          {
            mtime: new Date(2020, 0, 1),
            os: 3,
            attrs: ((item.name === "run.sh" ? 0o100755 : 0o100644) << 16) >>> 0,
          },
        ];
      }
    }
  }
  await collect(stage);
  if (uncompressedBytes > 200 * 1024 * 1024)
    throw new Error(
      "Runtime package exceeds the 200 MiB budget reserved below Lambda's code/layer limit.",
    );
  const archive = zipSync(archiveFiles, { level: 6 });
  const hash = sha256(archive);
  const filename = localTest
    ? "kieli-local-test.zip"
    : `kieli-${pkg.version}-${hash.slice(0, 16)}.zip`;
  await writeFile(join(destination, filename), archive, { flag: "wx" });
  const manifest = {
    version: pkg.version,
    sha256: hash,
    file: filename,
    uncompressedBytes,
    bytes: archive.byteLength,
    platform: process.platform,
    architecture: process.arch,
    publishable: !localTest,
    adapterLayerVersion: 30,
  };
  await writeFile(
    join(destination, "release.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    { flag: "wx" },
  );
  return { ...manifest, stage, directory: destination };
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      "local-test": { type: "boolean", default: false },
    },
  });
  const result = await packageAws({
    out: values.out,
    localTest: values["local-test"],
  });
  console.log(JSON.stringify(result, null, 2));
}
