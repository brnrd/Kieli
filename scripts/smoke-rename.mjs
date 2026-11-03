import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
const directory = await mkdtemp(join(tmpdir(), "kieli-rename-"));
const origin = "http://127.0.0.1:4341";
const server = spawn(process.execPath, ["dist/server/entry.mjs"], {
  env: {
    ...process.env,
    NODE_ENV: "development",
    AUTH_MODE: "demo",
    STORAGE_DRIVER: "sqlite",
    SQLITE_PATH: join(directory, "data.sqlite"),
    HOST: "127.0.0.1",
    PORT: "4341",
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
      name: "Rename smoke",
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
  const plan = await json(
    await api("/web/keys/hello/rename-preview", "POST", {
      name: "greeting",
      version: key.version,
    }),
  );
  assert.deepEqual(plan.references, [
    { name: "linked", languages: ["en", "fr"] },
  ]);
  const { references, affectedKeys, ...input } = plan;
  const renamed = await json(
    await api("/web/keys/hello/rename", "POST", input),
  );
  assert.equal(renamed.id, key.id);
  assert.equal((await api("/web/keys/hello")).status, 404);
  const linked = await json(await api("/web/keys/linked"));
  assert.equal(linked.translations.fr, "[%key:greeting%]");
  assert.equal(linked.resolvedTranslations.fr, "Bonjour");
  assert.deepEqual(linked.outdatedLanguages, []);
  const history = await json(await api("/web/keys/greeting/history"));
  assert.equal(history.items[0].origin, "rename");
  assert.equal(
    (
      await api("/web/keys/greeting/rename-preview", "POST", {
        name: "linked",
        version: renamed.version,
      })
    ).status,
    409,
  );
  assert.equal(
    (await api("/web/keys/hello/rename", "POST", input)).status,
    409,
  );
  console.log(
    "Key rename HTTP smoke passed: preview, atomic references, history, freshness, collision and replay guards.",
  );
} finally {
  if (server.exitCode === null) {
    server.kill("SIGTERM");
    await once(server, "exit");
  }
  await rm(directory, { recursive: true, force: true });
}
