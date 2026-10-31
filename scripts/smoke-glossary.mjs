import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
const directory = await mkdtemp(join(tmpdir(), "keylo-glossary-")),
  origin = "http://127.0.0.1:4334";
const server = spawn(process.execPath, ["dist/server/entry.mjs"], {
  env: {
    ...process.env,
    NODE_ENV: "development",
    AUTH_MODE: "demo",
    STORAGE_DRIVER: "sqlite",
    SQLITE_PATH: join(directory, "data.sqlite"),
    HOST: "127.0.0.1",
    PORT: "4334",
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
      id: "glossary",
      name: "Glossary smoke",
      sourceLanguage: "en",
      languages: [
        { code: "en", name: "English" },
        { code: "fr", name: "French" },
        { code: "ar", name: "Arabic" },
      ],
    }),
    201,
  );
  assert.equal((await api("/projects/glossary/glossary")).status, 200);
  const input = {
    source: "workspace",
    translations: { fr: "espace de travail", ar: "مساحة العمل" },
    notes: "Use for the whole team.",
    caseSensitive: false,
  };
  const term = await json(
    await api("/api/projects/glossary/glossary", "POST", input),
    201,
  );
  assert.equal(
    (
      await api("/api/projects/glossary/glossary", "POST", {
        ...input,
        source: "WORKSPACE",
      })
    ).status,
    409,
  );
  const updated = await json(
    await api(`/api/projects/glossary/glossary/${term.id}`, "PATCH", {
      ...input,
      version: 1,
      notes: "Updated usage",
    }),
  );
  assert.equal(updated.version, 2);
  assert.equal(
    (
      await api(`/api/projects/glossary/glossary/${term.id}`, "PATCH", {
        ...input,
        version: 1,
      })
    ).status,
    409,
  );
  const lookup = await json(
    await api("/api/projects/glossary/glossary/lookup", "POST", {
      text: "Open your WORKSPACE",
      language: "fr",
    }),
  );
  assert.deepEqual(lookup.items[0].translations, { fr: "espace de travail" });
  assert.equal(
    (
      await json(
        await api("/api/projects/glossary/glossary/lookup", "POST", {
          text: "workspaces",
        }),
      )
    ).total,
    0,
  );
  const batch = {
    batchId: randomUUID(),
    sourceLanguage: "en",
    terms: [
      { ...input, translations: { fr: "Do not replace" } },
      { source: "billing", translations: { fr: "facturation" } },
    ],
  };
  assert.deepEqual(
    await json(
      await api("/api/projects/glossary/glossary/import", "POST", batch),
    ),
    { added: 1, skipped: 1, replayed: false },
  );
  assert.deepEqual(
    await json(
      await api("/api/projects/glossary/glossary/import", "POST", batch),
    ),
    { added: 1, skipped: 1, replayed: true },
  );
  assert.equal(
    (
      await api("/api/projects/glossary/glossary/import", "POST", {
        batchId: randomUUID(),
        sourceLanguage: "en",
        terms: [
          { source: "Good" },
          { source: "Bad", translations: { xx: "Unknown" } },
        ],
      })
    ).status,
    400,
  );
  assert.equal(
    (await json(await api("/api/projects/glossary/glossary"))).total,
    2,
  );
  const exported = await json(
    await api("/api/projects/glossary/glossary/export"),
  );
  assert.equal(exported.format, "keylo-glossary");
  assert.equal(exported.terms.length, 2);
  assert.equal(
    exported.terms.find((item) => item.source === "workspace").translations.fr,
    "espace de travail",
  );
  assert.ok(exported.terms.every((item) => !("id" in item)));
  const token = await json(
    await api("/api/projects/glossary/tokens", "POST", {
      name: "Read-only export",
    }),
    201,
  );
  assert.equal(
    (
      await api("/api/projects/glossary/glossary", "GET", undefined, {
        authorization: `Bearer ${token.secret}`,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await api(
        `/api/projects/glossary/glossary/${term.id}?version=1`,
        "DELETE",
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await api(
        `/api/projects/glossary/glossary/${term.id}?version=2`,
        "DELETE",
      )
    ).status,
    204,
  );
  assert.equal(
    (await json(await api("/api/projects/glossary/glossary"))).total,
    1,
  );
  console.log(
    "Glossary HTTP smoke passed: CRUD, version conflicts, literal lookup, add-only imports, replay receipts, export and credential separation.",
  );
} finally {
  server.kill("SIGTERM");
  await Promise.race([
    once(server, "exit"),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
  await rm(directory, { recursive: true, force: true });
}
