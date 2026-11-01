import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
const directory = await mkdtemp(join(tmpdir(), "keylo-memory-")),
  origin = "http://127.0.0.1:4337";
const server = spawn(process.execPath, ["dist/server/entry.mjs"], {
  env: {
    ...process.env,
    NODE_ENV: "development",
    AUTH_MODE: "demo",
    STORAGE_DRIVER: "sqlite",
    SQLITE_PATH: join(directory, "data.sqlite"),
    HOST: "127.0.0.1",
    PORT: "4337",
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
  await json(
    await api("/api/projects", "POST", {
      id: "memory",
      name: "Memory smoke",
      sourceLanguage: "en",
      languages: [
        { code: "en", name: "English" },
        { code: "fr", name: "French" },
        { code: "nl", name: "Dutch" },
      ],
    }),
    201,
  );
  const original = await json(
    await api("/api/projects/memory/keys", "POST", {
      name: "original",
      translations: {
        en: "Hello {name}",
        fr: "Bonjour {name}",
        nl: "Hallo {name}",
      },
    }),
    201,
  );
  const target = await json(
    await api("/api/projects/memory/keys", "POST", {
      name: "target",
      translations: { en: "Hello {name}" },
    }),
    201,
  );
  const input = { source: "Hello {name}", language: "fr" };
  const path = "/api/projects/memory/translation-memory";
  const page = await json(await api(path, "POST", input));
  assert.equal(page.items[0].text, "Bonjour {name}");
  assert.equal(page.items[0].keyName, "original");
  assert.equal(JSON.stringify(page).includes("Hallo"), false);
  assert.equal(
    (await json(await api("/api/projects/memory/keys/target"))).translations.fr,
    undefined,
  );
  const saved = await json(
    await api("/api/projects/memory/keys/target", "PATCH", {
      version: target.version,
      expectedSourceContext: target.sourceContext,
      translations: { fr: page.items[0].text },
    }),
  );
  assert.equal(saved.translations.en, "Hello {name}");
  assert.equal(saved.translations.fr, "Bonjour {name}");
  assert.equal(
    (
      await api("/api/projects/memory/keys/target", "PATCH", {
        version: target.version,
        translations: { fr: "Stale {name}" },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await api("/api/projects/memory/keys/target", "PATCH", {
        version: saved.version,
        translations: { fr: "Wrong {other}" },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await api(
        `/api/projects/memory/keys/original?version=${original.version}`,
        "DELETE",
      )
    ).status,
    204,
  );
  assert.ok(
    (await json(await api(path, "POST", input))).items.every(
      (item) => item.keyName !== "original",
    ),
  );
  const status = await json(await api(path + "/index", "POST", {}));
  assert.equal(status.done, true);
  assert.deepEqual(await json(await api(path + "/index", "POST", {})), status);
  assert.equal(
    (await api(path, "POST", { ...input, cursor: "bad" })).status,
    400,
  );
  assert.equal(
    (await api(path, "POST", { ...input, source: "x".repeat(270000) })).status,
    413,
  );
  assert.equal(
    (await api(path + "/index", "POST", { padding: "x".repeat(270000) }))
      .status,
    413,
  );
  assert.equal(
    (await api(path, "POST", input, { origin: "https://foreign.example.com" }))
      .status,
    403,
  );
  const token = await json(
    await api("/api/projects/memory/tokens", "POST", { name: "export only" }),
    201,
  );
  assert.equal(
    (
      await api(path, "POST", input, {
        authorization: `Bearer ${token.secret}`,
      })
    ).status,
    403,
  );
  console.log(
    "Translation-memory HTTP smoke passed: exact matches, draft-only lookup, provenance, normal save guards, deleted-key filtering, resumable indexing, bounded requests and credential separation.",
  );
} finally {
  server.kill("SIGTERM");
  await Promise.race([
    once(server, "exit"),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
  await rm(directory, { recursive: true, force: true });
}
