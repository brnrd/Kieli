import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { zipSync, strToU8, unzipSync, strFromU8 } from "fflate";
import { parseTranslationFiles } from "../src/formats/import.ts";
import { parseStringsDict } from "../src/formats/stringsdict.ts";
const directory = await mkdtemp(join(tmpdir(), "kieli-apple-")),
  origin = "http://127.0.0.1:4339";
const server = spawn(process.execPath, ["dist/server/entry.mjs"], {
  env: {
    ...process.env,
    NODE_ENV: "development",
    AUTH_MODE: "demo",
    STORAGE_DRIVER: "sqlite",
    SQLITE_PATH: join(directory, "data.sqlite"),
    HOST: "127.0.0.1",
    PORT: "4339",
    APP_ORIGIN: origin,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
server.stdout.on("data", (data) => (logs += data));
server.stderr.on("data", (data) => (logs += data));
const api = (path, method = "GET", body, headers = {}) =>
  fetch(origin + path, {
    method,
    headers: { origin, "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
async function json(response, status = 200) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}
try {
  let ready = false;
  for (let i = 0; i < 50; i++) {
    if (server.exitCode !== null) throw Error(logs);
    try {
      ready = (await fetch(origin + "/api/health")).ok;
    } catch {}
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, logs);
  const en = await readFile(
    new URL("../tests/fixtures/stringsdict/en.stringsdict", import.meta.url),
    "utf8",
  );
  const ru = await readFile(
    new URL("../tests/fixtures/stringsdict/ru.stringsdict", import.meta.url),
    "utf8",
  );
  const preview = parseTranslationFiles(
    zipSync({
      "en.stringsdict": strToU8(en),
      "en.strings": strToU8('"greeting" = "Hello";'),
      "ru.stringsdict": strToU8(ru),
    }),
    "apple.zip",
  );
  const importId = randomUUID();
  await json(
    await api("/api/imports/files/start", "POST", {
      importId,
      project: {
        id: "apple",
        name: "Apple smoke",
        sourceLanguage: "en",
        languages: preview.languages,
      },
    }),
    201,
  );
  assert.equal(
    (
      await json(
        await api("/api/projects/apple/import", "POST", {
          importId,
          keys: preview.keys,
        }),
      )
    ).imported,
    4,
  );
  const token = await json(
    await api("/api/projects/apple/tokens", "POST", { name: "Native export" }),
    201,
  );
  const authorization = { authorization: `Bearer ${token.secret}` };
  const exported = await json(
    await api(
      "/api/projects/apple/export?format=stringsdict&languages=en,ru",
      "GET",
      undefined,
      authorization,
    ),
  );
  assert.equal(exported.files.length, 4);
  for (const locale of ["en", "ru"]) {
    const resource = exported.files.find(
      (file) => file.name === `${locale}.stringsdict`,
    );
    assert.equal(
      parseStringsDict(resource.content).types.get("cart.items"),
      "ld",
    );
    const folder = join(directory, `${locale}.lproj`);
    await mkdir(folder);
    await writeFile(join(folder, "Localizable.stringsdict"), resource.content);
    await writeFile(
      join(folder, "Localizable.strings"),
      exported.files.find((file) => file.name === `${locale}.strings`).content,
    );
  }
  const zipResponse = await api(
    "/api/projects/apple/export?format=stringsdict&languages=en&download=zip",
    "GET",
    undefined,
    authorization,
  );
  assert.equal(zipResponse.status, 200);
  const archive = unzipSync(new Uint8Array(await zipResponse.arrayBuffer()));
  assert.deepEqual(Object.keys(archive), ["en.stringsdict", "en.strings"]);
  assert.equal(
    parseStringsDict(strFromU8(archive["en.stringsdict"])).types.get(
      "counts.special",
    ),
    "lld",
  );
  const cli = spawn(
    process.execPath,
    [
      "cli/kieli.mjs",
      "pull",
      "--url",
      origin,
      "--project",
      "apple",
      "--format",
      "stringsdict",
      "--languages",
      "en,ru",
      "--out",
      join(directory, "cli"),
    ],
    {
      env: { ...process.env, KIELI_TOKEN: token.secret },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let cliError = "";
  cli.stderr.on("data", (data) => (cliError += data));
  assert.equal((await once(cli, "exit"))[0], 0, cliError);
  assert.match(
    await readFile(join(directory, "cli/en.strings"), "utf8"),
    /Hello/,
  );
  assert.equal(
    parseStringsDict(
      await readFile(join(directory, "cli/en.stringsdict"), "utf8"),
    ).types.get("counts.special"),
    "lld",
  );
  const key = await json(await api("/api/projects/apple/keys/cart.items"));
  await json(
    await api("/api/projects/apple/keys/cart.items", "PATCH", {
      version: key.version,
      description: "Updated context",
      translations: {},
    }),
  );
  assert.equal(
    (await json(await api("/api/projects/apple/keys/cart.items")))
      .applePluralTypes.en,
    "ld",
  );
  assert.equal(
    (
      await api("/api/projects/apple/keys", "POST", {
        name: "bad",
        translations: { en: "Hello" },
        applePluralTypes: { de: "ld" },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await api("/api/projects/apple/keys/cart.items", "PATCH", {
        version: key.version + 1,
        translations: {},
        applePluralTypes: { en: "f" },
      })
    ).status,
    400,
  );
  if (process.argv.includes("--native")) {
    const swift = spawn(
      "swift",
      [
        "-module-cache-path",
        join(directory, "swift-cache"),
        "scripts/check-apple-native.swift",
        directory,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    swift.stdout.on("data", (data) => (output += data));
    swift.stderr.on("data", (data) => (output += data));
    assert.equal((await once(swift, "exit"))[0], 0, output);
    console.log(output.trim());
  }
  console.log(
    "Apple file HTTP/CLI smoke passed: native import metadata, companion files, scoped JSON/ZIP/CLI exports, preserved edits and invalid metadata rejection.",
  );
} finally {
  server.kill("SIGTERM");
  await Promise.race([
    once(server, "exit"),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
  await rm(directory, { recursive: true, force: true });
}
