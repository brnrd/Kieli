import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
const directory = await mkdtemp(join(tmpdir(), "kieli-duplicate-"));
const origin = "http://127.0.0.1:4348";
const server = spawn(process.execPath, ["dist/server/entry.mjs"], {
  env: {
    ...process.env,
    NODE_ENV: "development",
    AUTH_MODE: "demo",
    STORAGE_DRIVER: "sqlite",
    SQLITE_PATH: join(directory, "data.sqlite"),
    HOST: "127.0.0.1",
    PORT: "4348",
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
  console.log(
    "Duplicate HTTP smoke passed: identity, copied targets, collision and preserved freshness.",
  );
} finally {
  if (server.exitCode === null) {
    server.kill("SIGTERM");
    await once(server, "exit");
  }
  await rm(directory, { recursive: true, force: true });
}
