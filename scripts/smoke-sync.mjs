import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const directory = await mkdtemp(join(tmpdir(), "keylo-sync-smoke-")),
  origin = "http://127.0.0.1:4332";
const env = {
  ...process.env,
  NODE_ENV: "development",
  AUTH_MODE: "demo",
  APP_ORIGIN: origin,
  HOST: "127.0.0.1",
  PORT: "4332",
  STORAGE_DRIVER: "sqlite",
  SQLITE_PATH: join(directory, "data.sqlite"),
};
const server = spawn(process.execPath, ["dist/server/entry.mjs"], {
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
server.stdout.on("data", (data) => (logs += data));
server.stderr.on("data", (data) => (logs += data));
const api = (path, method = "GET", body, headers = {}) =>
  fetch(origin + path, {
    method,
    redirect: "manual",
    headers: { origin, "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
async function json(response, status = 200) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}
async function cli(args, token, success = true) {
  const processCLI = spawn(process.execPath, ["cli/keylo.mjs", ...args], {
    env: { ...env, KEYLO_SYNC_TOKEN: token },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "",
    error = "";
  processCLI.stdout.on("data", (data) => (output += data));
  processCLI.stderr.on("data", (data) => (error += data));
  const [code] = await once(processCLI, "exit");
  assert.equal(code, success ? 0 : 1, error);
  assert.ok(!output.includes(token) && !error.includes(token));
  return output + error;
}
try {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      ready = (await api("/api/health")).ok;
    } catch {}
    if (ready) break;
    if (server.exitCode !== null) throw new Error(logs);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, logs);
  await json(
    await api("/api/projects", "POST", {
      id: "sync-smoke",
      name: "Sync smoke",
      sourceLanguage: "en",
      languages: [
        { code: "en", name: "English" },
        { code: "fr", name: "French" },
      ],
    }),
    201,
  );
  await json(
    await api("/api/projects/sync-smoke/keys", "POST", {
      name: "home.title",
      translations: { en: "Hello {name}", fr: "Bonjour {name}" },
    }),
    201,
  );
  const issued = await json(
    await api("/api/projects/sync-smoke/sync-tokens", "POST", {
      name: "Test CI",
      prefixes: ["home."],
    }),
    201,
  );
  const path = join(directory, ".keylo.json");
  await writeFile(
    join(directory, "en.json"),
    JSON.stringify({ home: { title: "Welcome {name}", button: "Continue" } }),
  );
  await writeFile(
    path,
    JSON.stringify({
      url: origin,
      project: "sync-smoke",
      sourceLanguage: "en",
      push: { files: [{ path: "en.json", format: "nested" }] },
    }),
  );
  assert.match(
    await cli(["push", "--config", path], issued.secret),
    /Dry run: 1 new, 1 updated/,
  );
  assert.equal(
    (await json(await api("/api/projects/sync-smoke/keys/home.title")))
      .translations.en,
    "Hello {name}",
  );
  assert.match(
    await cli(["push", "--config", path, "--apply"], issued.secret),
    /Applied: 1 new, 1 updated/,
  );
  const key = await json(await api("/api/projects/sync-smoke/keys/home.title"));
  assert.equal(key.translations.fr, "Bonjour {name}");
  assert.deepEqual(key.outdatedLanguages, ["fr"]);
  assert.match(
    await cli(["push", "--config", path, "--apply"], issued.secret),
    /0 new, 0 updated, 2 unchanged/,
  );
  assert.equal(
    (
      await api("/api/bootstrap", "GET", undefined, {
        authorization: `Bearer ${issued.secret}`,
      })
    ).status,
    401,
  );
  const exportToken = await json(
    await api("/api/projects/sync-smoke/tokens", "POST", { name: "Pull" }),
    201,
  );
  assert.equal(
    (
      await api(
        "/sync/sync-smoke/preview",
        "POST",
        { keys: [] },
        { authorization: `Bearer ${exportToken.secret}` },
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await api(
        "/sync/sync-smoke/preview",
        "POST",
        { keys: [{ name: "home.title", translations: { fr: "Not allowed" } }] },
        { authorization: `Bearer ${issued.secret}` },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await api("/api/projects/sync-smoke/export", "GET", undefined, {
        authorization: `Bearer ${issued.secret}`,
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await api(
        `/api/projects/sync-smoke/sync-tokens/${issued.credential.id}`,
        "DELETE",
      )
    ).status,
    204,
  );
  assert.match(
    await cli(["push", "--config", path], issued.secret, false),
    /401/,
  );
  console.log(
    "Source sync HTTP/CLI smoke passed: config paths, dry-run, apply, retry-safe repeats, target protection, credential separation and revocation.",
  );
} finally {
  if (server.exitCode === null) {
    server.kill("SIGTERM");
    await once(server, "exit");
  }
  await rm(directory, { recursive: true, force: true });
}
