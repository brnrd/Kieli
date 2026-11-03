import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
const directory = await mkdtemp(join(tmpdir(), "kieli-archive-"));
const origin = "http://127.0.0.1:4343";
const server = spawn(process.execPath, ["dist/server/entry.mjs"], {
  env: {
    ...process.env,
    NODE_ENV: "development",
    AUTH_MODE: "demo",
    STORAGE_DRIVER: "sqlite",
    SQLITE_PATH: join(directory, "data.sqlite"),
    HOST: "127.0.0.1",
    PORT: "4343",
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
      name: "Archive smoke",
      sourceLanguage: "en",
      languages: [
        { code: "en", name: "English" },
        { code: "fr", name: "French" },
      ],
    }),
    201,
  );
  const key = await json(
    await api("/web/keys", "POST", {
      name: "hello",
      translations: { en: "Hello", fr: "Bonjour" },
    }),
    201,
  );
  await json(
    await api("/web/keys", "POST", {
      name: "linked",
      translations: { en: "[%key:hello%]", fr: "[%key:hello%]" },
    }),
    201,
  );
  const token = await json(
    await api("/web/tokens", "POST", { name: "Existing CI" }),
    201,
  );
  const archived = await json(
    await api("/web/archive", "POST", { version: 1, archived: true }),
  );
  assert.ok(archived.archivedAt);
  assert.equal(
    (await json(await api("/web/keys/hello"))).translations.fr,
    "Bonjour",
  );
  assert.equal(
    (
      await api("/web/keys/hello", "PATCH", {
        version: key.version,
        translations: { fr: "Changed" },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await api("/web/keys", "POST", {
        name: "new",
        translations: { en: "New" },
      })
    ).status,
    409,
  );
  const headers = { authorization: `Bearer ${token.secret}` };
  assert.equal(
    (
      await fetch(
        `${origin}/api/projects/web/export?format=flat&languages=fr`,
        { headers },
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await fetch(`${origin}/api/projects/web/archive`, {
        method: "POST",
        headers: { ...headers, origin, "content-type": "application/json" },
        body: JSON.stringify({ version: archived.version, archived: false }),
      })
    ).status,
    403,
  );
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
      "fr",
      "--format",
      "flat",
      "--out",
      join(directory, "locales"),
      "--plain",
    ],
    {
      env: { ...process.env, KIELI_TOKEN: token.secret },
      encoding: "utf8",
      timeout: 20000,
    },
  );
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(
    JSON.parse(await readFile(join(directory, "locales/fr.json"), "utf8"))
      .hello,
    "Bonjour",
  );
  assert.equal(
    (await api("/web/archive", "POST", { version: 1, archived: false })).status,
    409,
  );
  const restored = await json(
    await api("/web/archive", "POST", {
      version: archived.version,
      archived: false,
    }),
  );
  assert.equal(restored.archivedAt, undefined);
  await json(
    await api("/web/keys/hello", "PATCH", {
      version: key.version,
      translations: { fr: "Salut" },
    }),
  );
  console.log(
    "Project archive HTTP/CLI smoke passed: manager archive/restore, stale-state guards, read-only mutations, existing export token and real CLI pull.",
  );
} finally {
  if (server.exitCode === null) {
    server.kill("SIGTERM");
    await once(server, "exit");
  }
  await rm(directory, { recursive: true, force: true });
}
