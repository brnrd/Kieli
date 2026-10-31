import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { zipSync } from "fflate";
const files = {};
async function walk(directory, relative = "") {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (
      entry.name.startsWith(".") ||
      ["build", "pubspec.lock", "local.properties"].includes(entry.name)
    )
      continue;
    const path = new URL(
      entry.name + (entry.isDirectory() ? "/" : ""),
      directory,
    );
    const name = relative + entry.name;
    if (entry.isDirectory()) await walk(path, name + "/");
    else files["keylo-sdks/" + name] = new Uint8Array(await readFile(path));
  }
}
await walk(new URL("../sdks/", import.meta.url));
await mkdir(new URL("../public/downloads/", import.meta.url), {
  recursive: true,
});
await writeFile(
  new URL("../public/downloads/keylo-sdks.zip", import.meta.url),
  zipSync(files, { level: 6 }),
);
console.log("Packaged Keylo client SDK sources.");
