import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
const directory = await mkdtemp(join(tmpdir(), "kieli-bulk-"));
const origin = "http://127.0.0.1:4346";
const server = spawn(process.execPath, ["dist/server/entry.mjs"], {
  env: {
    ...process.env,
    NODE_ENV: "development",
    AUTH_MODE: "demo",
    STORAGE_DRIVER: "sqlite",
    SQLITE_PATH: join(directory, "data.sqlite"),
    HOST: "127.0.0.1",
    PORT: "4346",
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
      name: "Bulk smoke",
      sourceLanguage: "en",
      languages: [
        { code: "en", name: "English" },
        { code: "fr", name: "French" },
      ],
    }),
    201,
  );
  const keys = [];
  for (let i = 0; i < 23; i++)
    keys.push(
      await json(
        await api("/web/keys", "POST", {
          name: `key.${String(i).padStart(3, "0")}`,
          namespace: "original",
          tags: ["legacy"],
          translations: { en: `Hello ${i}`, fr: `Bonjour ${i}` },
        }),
        201,
      ),
    );
  const token = await json(
    await api("/web/tokens", "POST", { name: "CI" }),
    201,
  );
  const input = {
    keys: keys.map(({ name, version }) => ({ name, version })),
    operation: {
      addTags: ["bulk"],
      removeTags: ["legacy"],
      namespace: "checkout",
    },
  };
  const invalidOrigin = await fetch(
    `${origin}/api/projects/web/metadata/preview`,
    {
      method: "POST",
      headers: {
        origin: "https://attacker.example",
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
    },
  );
  assert.equal(invalidOrigin.status, 403);
  const forbidden = await fetch(`${origin}/api/projects/web/metadata/preview`, {
    method: "POST",
    headers: {
      origin,
      authorization: `Bearer ${token.secret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(input),
  });
  assert.equal(forbidden.status, 403);
  assert.equal(
    (
      await api("/web/metadata/preview", "POST", {
        ...input,
        operation: { translations: { fr: "Forbidden" } },
      })
    ).status,
    400,
  );
  const plan = await json(await api("/web/metadata/preview", "POST", input));
  assert.equal(plan.changed, 23);
  assert.equal(plan.processed, 0);
  assert.equal(
    (await json(await api("/web/keys/key.000"))).namespace,
    "original",
  );
  const first = await json(
    await api(`/web/metadata/${plan.id}/apply`, "POST", { offset: 0 }),
  );
  assert.equal(first.processed, 10);
  assert.equal(first.updated, 10);
  assert.deepEqual(
    await json(
      await api(`/web/metadata/${plan.id}/apply`, "POST", { offset: 0 }),
    ),
    first,
  );
  await json(
    await api("/web/keys/key.014", "PATCH", {
      version: 1,
      translations: { fr: "Concurrent copy" },
    }),
  );
  assert.equal(
    (await api(`/web/metadata/${plan.id}/apply`, "POST", { offset: 10 }))
      .status,
    409,
  );
  const progress = await json(await api(`/web/metadata/${plan.id}`));
  assert.equal(progress.processed, 10);
  assert.equal(
    (await json(await api("/web/keys/key.010"))).namespace,
    "original",
  );
  const remaining = [];
  for (const entry of plan.entries.slice(progress.processed)) {
    const key = await json(await api(`/web/keys/${entry.name}`));
    remaining.push({ name: key.name, version: key.version });
  }
  const next = await json(
    await api("/web/metadata/preview", "POST", { ...input, keys: remaining }),
  );
  const second = await json(
    await api(`/web/metadata/${next.id}/apply`, "POST", { offset: 0 }),
  );
  const done = await json(
    await api(`/web/metadata/${next.id}/apply`, "POST", {
      offset: second.processed,
    }),
  );
  assert.equal(done.processed, 13);
  assert.equal(done.done, true);
  const page = await json(
    await api("/web/keys?q=bulk&namespace=checkout&limit=100"),
  );
  assert.equal(page.items.length, 23);
  assert.deepEqual(page.stats.namespaces, { checkout: 23 });
  const history = await json(await api("/web/keys/key.000/history"));
  assert.equal(history.items[0].origin, "metadata");
  assert.equal(
    (await json(await api("/web/keys/key.014"))).translations.fr,
    "Concurrent copy",
  );
  assert.equal((await json(await api("/web/keys/key.000"))).version, 2);
  const disabled = await json(
    await api("/web/languages/fr", "POST", { version: 1, enabled: false }),
  );
  const noop = await json(
    await api("/web/metadata/preview", "POST", {
      keys: [{ name: "key.000", version: 2 }],
      operation: { addTags: ["bulk"] },
    }),
  );
  const unchanged = await json(
    await api(`/web/metadata/${noop.id}/apply`, "POST", { offset: 0 }),
  );
  assert.equal(unchanged.updated, 0);
  assert.equal(unchanged.skipped, 1);
  assert.equal((await json(await api("/web/keys/key.000"))).version, 2);
  await json(
    await api("/web/archive", "POST", {
      version: disabled.version,
      archived: true,
    }),
  );
  assert.equal((await api("/web/metadata/preview", "POST", input)).status, 409);
  console.log(
    "Bulk metadata HTTP smoke passed: previews, bounded batches, durable progress/replays, conflicts, role/credential/origin boundaries, search/counters/history and retained copy.",
  );
} finally {
  if (server.exitCode === null) {
    server.kill("SIGTERM");
    await once(server, "exit");
  }
  await rm(directory, { recursive: true, force: true });
}
