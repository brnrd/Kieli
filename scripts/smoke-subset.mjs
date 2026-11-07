import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
const directory = await mkdtemp(join(tmpdir(), "kieli-subset-"));
const origin = "http://127.0.0.1:4349";
const server = spawn(process.execPath, ["dist/server/entry.mjs"], {
  env: {
    ...process.env,
    NODE_ENV: "development",
    AUTH_MODE: "demo",
    STORAGE_DRIVER: "sqlite",
    SQLITE_PATH: join(directory, "data.sqlite"),
    HOST: "127.0.0.1",
    PORT: "4349",
    APP_ORIGIN: origin,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
server.stdout.on("data", (data) => (logs += data));
server.stderr.on("data", (data) => (logs += data));
const api = (path, method = "GET", body) =>
  fetch(`${origin}/api/projects${path}`, {
    method,
    headers: { origin, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
async function json(response, status = 200) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}
try {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (server.exitCode !== null) throw Error(logs);
    try {
      ready = (await fetch(`${origin}/api/health`)).ok;
    } catch {}
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, logs);
  await json(
    await api("", "POST", {
      id: "web",
      name: "Duplicate",
      sourceLanguage: "en",
      languages: [
        { code: "en", name: "English" },
        { code: "fr", name: "French" },
      ],
    }),
    201,
  );
  await json(
    await api("/web/keys", "POST", {
      name: "hello",
      translations: { en: "Hello", fr: "Bonjour" },
    }),
    201,
  );
  const copy = await json(
    await api("/web/keys/hello/duplicate", "POST", {
      name: "copy",
      version: 1,
      copyTargets: true,
    }),
    201,
  );
  assert.equal(copy.translations.fr, "Bonjour");
  assert.equal(
    (
      await api("/web/keys/hello/duplicate", "POST", {
        name: "copy",
        version: 1,
      })
    ).status,
    409,
  );
  await json(
    await api("/web/keys/hello", "PATCH", {
      version: 1,
      translations: { en: "Hi" },
    }),
  );
  const stale = await json(
    await api("/web/keys/hello/duplicate", "POST", {
      name: "stale",
      version: 2,
      copyTargets: true,
    }),
    201,
  );
  assert.deepEqual(stale.outdatedLanguages, ["fr"]);
  const subset = await json(
    await api("/web/export?languages=fr&keys=copy&requireCurrent=true"),
  );
  assert.deepEqual(Object.keys(subset.translations.fr), ["copy"]);
  assert.equal((await api("/web/export?keys=gone")).status, 404);
  assert.equal((await api("/web/export?namespace=gone")).status, 422);
  const token = await json(
    await api("/web/tokens", "POST", { name: "CLI" }),
    201,
  );
  const { spawnSync } = await import("node:child_process");
  for (const flags of [
    ["--keys", "copy"],
    ["--namespace", "general"],
  ]) {
    const cli = spawnSync(
      process.execPath,
      [
        "cli/kieli.mjs",
        "pull",
        "--url",
        origin,
        "--project",
        "web",
        "--languages",
        "en",
        "--out",
        join(directory, flags[0].slice(2)),
        "--plain",
        ...flags,
      ],
      { env: { ...process.env, KIELI_TOKEN: token.secret }, encoding: "utf8" },
    );
    assert.equal(cli.status, 0, cli.stderr);
    const { readFile } = await import("node:fs/promises");
    const values = JSON.parse(
      await readFile(join(directory, flags[0].slice(2), "en.json"), "utf8"),
    );
    assert.ok(values.copy);
    if (flags[0] === "--keys") assert.deepEqual(Object.keys(values), ["copy"]);
  }
  console.log(
    "Subset export HTTP/CLI smoke passed: key and namespace filters, strict selection gates and scoped CLI pulls.",
  );
} finally {
  if (server.exitCode === null) {
    server.kill("SIGTERM");
    await once(server, "exit");
  }
  await rm(directory, { recursive: true, force: true });
}
