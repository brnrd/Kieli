import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
const directory = await mkdtemp(join(tmpdir(), "kieli-features-"));
const origin = "http://127.0.0.1:4331",
  job = "a".repeat(64);
const server = spawn(process.execPath, ["dist/server/entry.mjs"], {
  env: {
    ...process.env,
    NODE_ENV: "development",
    AUTH_MODE: "demo",
    STORAGE_DRIVER: "sqlite",
    SQLITE_PATH: join(directory, "data.sqlite"),
    HOST: "127.0.0.1",
    PORT: "4331",
    APP_ORIGIN: origin,
    KIELI_SNAPSHOT_JOB_TOKEN: job,
    KIELI_SNAPSHOT_JOB_SECRET_ARN: "",
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
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      ready = (await api("/api/health")).ok;
    } catch {}
    if (ready) break;
    if (server.exitCode !== null) throw Error(logs);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, logs);
  const project = {
    id: "features",
    name: "Feature smoke",
    sourceLanguage: "en",
    languages: [
      { code: "en", name: "English" },
      { code: "fr", name: "French" },
    ],
    snapshotPolicy: { enabled: true, intervalHours: 24, retention: 2 },
  };
  await json(await api("/api/projects", "POST", project), 201);
  await json(
    await api("/api/projects/features/keys", "POST", {
      name: "brand",
      translations: { en: "Kieli", fr: "Kieli" },
    }),
    201,
  );
  await json(
    await api("/api/projects/features/keys", "POST", {
      name: "welcome",
      translations: {
        en: "Welcome to [%key:brand%]",
        fr: "Bienvenue sur [%key:brand%]",
      },
    }),
    201,
  );
  await json(
    await api("/api/projects/features/keys", "POST", {
      name: "items",
      plural: true,
      translations: {
        en: "{count, plural, one {One item} other {# items}}",
        fr: "{count, plural, one {Un article} many {# articles} other {# articles}}",
      },
    }),
    201,
  );
  const snapshot = await json(
    await api("/api/projects/features/snapshots", "POST", { label: "Before" }),
    201,
  );
  const manifest = await json(
    await api(`/api/projects/features/snapshots/${snapshot.id}`),
  );
  assert.equal(manifest.keys, 3);
  assert.equal(
    (await api("/api/projects/features/snapshots", "POST", null)).status,
    400,
  );
  const credential = await json(
    await api("/api/projects/features/delivery-keys", "POST", {
      name: "Smoke app",
    }),
    201,
  );
  const release = await json(
    await api("/api/projects/features/releases", "POST", {
      label: "First",
      channel: "production",
      expectedHeadVersion: 0,
    }),
    201,
  );
  const deliveryPath = "/ota/features/fr?channel=production";
  assert.equal((await api(deliveryPath)).status, 401);
  assert.equal(
    (
      await api(deliveryPath, "GET", undefined, {
        authorization: "Bearer invalid-token-aaaaaaaaa",
      })
    ).status,
    401,
  );
  let delivered = await api(deliveryPath, "GET", undefined, {
    authorization: `Bearer ${credential.secret}`,
  });
  const etag = delivered.headers.get("etag");
  assert.equal(delivered.status, 200);
  assert.equal(delivered.headers.get("cache-control"), "private, no-cache");
  const bundle = await delivered.json();
  assert.equal(bundle.messages.welcome.value, "Bienvenue sur Kieli");
  assert.equal(bundle.messages.items.nodes[0].type, "plural");
  assert.ok(bundle.rules.cardinal);
  let before = await json(await api("/api/projects/features/keys/brand"));
  await json(
    await api("/api/projects/features/keys/brand", "PATCH", {
      version: before.version,
      translations: { fr: "Nouvelle marque" },
    }),
  );
  delivered = await api(deliveryPath, "GET", undefined, {
    authorization: `Bearer ${credential.secret}`,
    "if-none-match": etag,
  });
  assert.equal(delivered.status, 304);
  await json(
    await api(
      `/api/projects/features/snapshots/${snapshot.id}/restore`,
      "POST",
      { version: 1 },
    ),
  );
  assert.equal(
    (await json(await api("/api/projects/features/keys/brand"))).translations
      .fr,
    "Kieli",
  );
  delivered = await api(deliveryPath, "GET", undefined, {
    authorization: `Bearer ${credential.secret}`,
    "if-none-match": etag,
  });
  assert.equal(delivered.status, 304);
  await json(
    await api(`/api/projects/features/releases/activate`, "POST", {
      release: release.id,
      channel: "preview",
      expectedHeadVersion: 0,
    }),
  );
  const exportToken = await json(
    await api("/api/projects/features/tokens", "POST", { name: "CI" }),
    201,
  );
  for (const authorization of [
    "",
    `Bearer ${credential.secret}`,
    `Bearer ${exportToken.secret}`,
    job,
  ])
    assert.equal(
      (await api("/tasks/snapshots", "POST", {}, { authorization })).status,
      401,
    );
  const jobResult = await json(
    await api(
      "/tasks/snapshots",
      "POST",
      {},
      { authorization: `Bearer ${job}` },
    ),
  );
  assert.equal(jobResult.status, "ok");
  assert.equal(jobResult.results[0].status, "created");
  assert.equal(
    (await json(await api("/api/projects/features/releases"))).releases.length,
    1,
  );
  assert.equal(
    (
      await api(
        `/api/projects/features/delivery-keys/${credential.id}`,
        "DELETE",
      )
    ).status,
    204,
  );
  assert.equal(
    (
      await api(deliveryPath, "GET", undefined, {
        authorization: `Bearer ${credential.secret}`,
        "if-none-match": etag,
      })
    ).status,
    401,
  );
  await json(
    await api("/api/projects/features/keys", "POST", {
      name: "freshness",
      translations: { en: "Cancel subscription", fr: "Annuler" },
    }),
    201,
  );
  const outdated = await json(
    await api("/api/projects/features/keys/freshness", "PATCH", {
      version: 1,
      translations: { en: "Pause subscription" },
    }),
  );
  assert.deepEqual(outdated.outdatedLanguages, ["fr"]);
  const stalePage = await json(
    await api("/api/projects/features/keys?status=outdated"),
  );
  assert.deepEqual(
    stalePage.items.map((key) => key.name),
    ["freshness"],
  );
  const confirmed = await json(
    await api("/api/projects/features/keys/freshness", "PATCH", {
      version: outdated.version,
      expectedSourceContext: outdated.sourceContext,
      translations: { fr: "Suspendre" },
    }),
  );
  assert.deepEqual(confirmed.outdatedLanguages, []);
  const edits = await json(
    await api("/api/projects/features/keys/freshness/history"),
  );
  assert.equal(edits.items[0].after.translations.fr, "Suspendre");
  const restoredText = await json(
    await api(
      `/api/projects/features/keys/freshness/history/${encodeURIComponent(edits.items[0].id)}/restore`,
      "POST",
      {
        version: confirmed.version,
        language: "fr",
        side: "before",
        expectedSourceContext: confirmed.sourceContext,
      },
    ),
  );
  assert.equal(restoredText.translations.fr, "Annuler");
  assert.deepEqual(restoredText.outdatedLanguages, ["fr"]);
  const recoverable = await json(
    await api("/api/projects/features/keys", "POST", {
      name: "recoverable",
      translations: { en: "Disposable", fr: "Test" },
    }),
    201,
  );
  assert.equal(
    (
      await api(
        `/api/projects/features/keys/recoverable?version=${recoverable.version}`,
        "DELETE",
      )
    ).status,
    204,
  );
  const deleted = await json(await api("/api/projects/features/trash"));
  const item = deleted.items.find((item) => item.name === "recoverable");
  assert.ok(item);
  const recovered = await json(
    await api(`/api/projects/features/trash/${item.id}/restore`, "POST", {
      version: item.version,
    }),
  );
  assert.equal(recovered.id, recoverable.id);
  assert.ok(recovered.version > recoverable.version);
  const update = await json(
    await api("/api/projects/features/updates/preview", "POST", {
      keys: [
        {
          name: "imported.source",
          translations: { en: "New source", fr: "Nouvelle source" },
        },
      ],
    }),
  );
  assert.equal(update.created, 1);
  const receipt = await json(
    await api(`/api/projects/features/updates/${update.id}/apply`, "POST"),
  );
  assert.equal(receipt.replayed, false);
  assert.equal(
    (
      await json(
        await api(`/api/projects/features/updates/${update.id}/apply`, "POST"),
      )
    ).replayed,
    true,
  );
  const archive = await api("/downloads/kieli-sdks.zip");
  assert.equal(archive.status, 200);
  assert.ok((await archive.arrayBuffer()).byteLength > 1000);
  console.log(
    "Feature HTTP smoke passed: plurals, references, immutable delivery, restore, authenticated ETags, revocation, scheduled snapshots and SDK archive.",
  );
} finally {
  server.kill("SIGTERM");
  if (server.exitCode === null) await once(server, "exit");
  await rm(directory, { recursive: true, force: true });
}
