import test from "node:test";
import assert from "node:assert/strict";
import { sqliteStore, type Store } from "../src/server/store";
import { KeyloService } from "../src/server/service";
import { SyncCredentials } from "../src/server/sync-credentials";
import { handleSync } from "../src/server/sync";
import type { Identity } from "../src/shared";
import { HttpError } from "../src/server/errors";
process.env.AUTH_MODE = "demo";
process.env.APP_ORIGIN = "http://localhost:4321";
const admin: Identity = {
  sub: "admin",
  name: "Admin",
  email: "admin@example.com",
  admin: true,
  projects: {},
};
const request = (
  secret: string,
  path = "web/preview",
  body: unknown = {
    keys: [{ name: "home.title", translations: { en: "New source" } }],
  },
  headers: Record<string, string> = {},
) =>
  new Request(`http://localhost:4321/sync/${path}`, {
    method: "POST",
    headers: {
      host: "localhost:4321",
      "content-type": "application/json",
      authorization: `Bearer ${secret}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
async function fixture() {
  const store = await sqliteStore(":memory:"),
    svc = new KeyloService(store),
    credentials = new SyncCredentials(store);
  await svc.createProject(admin, {
    id: "web",
    name: "Web",
    sourceLanguage: "en",
    languages: [
      { code: "en", name: "English" },
      { code: "fr", name: "French" },
    ],
  });
  await svc.createKey(admin, "web", {
    name: "home.title",
    description: "Keep metadata",
    translations: { en: "Old source", fr: "Private target" },
  });
  const issued = await credentials.create(admin, "web", {
    name: "CI",
    prefixes: ["home."],
  });
  return { store, svc, credentials, issued };
}
test("source-sync credentials are hashed, source/prefix scoped, and previews never expose target copy", async () => {
  const f = await fixture();
  const stored = await f.store.list("PROJECT#web", "SYNC_TOKEN#");
  assert.ok(!JSON.stringify(stored).includes(f.issued.secret));
  let response = await handleSync(request(f.issued.secret), f.store);
  assert.equal(response.status, 200, await response.clone().text());
  const plan = await response.json();
  assert.ok(!JSON.stringify(plan).includes("Private target"));
  response = await handleSync(
    request(f.issued.secret, `web/apply/${plan.id}`, {}),
    f.store,
  );
  assert.equal(response.status, 200);
  const key = await f.svc.key(admin, "web", "home.title");
  assert.equal(key.translations.en, "New source");
  assert.equal(key.translations.fr, "Private target");
  assert.equal(key.description, "Keep metadata");
  assert.equal(
    (
      await handleSync(
        request(f.issued.secret, "web/preview", {
          keys: [{ name: "other.key", translations: { en: "No" } }],
        }),
        f.store,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await handleSync(
        request(f.issued.secret, "web/preview", {
          keys: [{ name: "home.title", translations: { fr: "No" } }],
        }),
        f.store,
      )
    ).status,
    403,
  );
  assert.equal(
    (await handleSync(request(f.issued.secret, "other/preview"), f.store))
      .status,
    403,
  );
  assert.equal(
    (await f.svc.keyHistory(admin, "web", "home.title", { limit: 1 })).items[0]!
      .origin,
    "sync",
  );
});
test("sync requires its own bearer credential and enforces host/origin, expiry and revocation", async () => {
  const f = await fixture();
  for (const [secret, headers] of [
    ["", {}],
    [f.issued.secret, { host: "attacker.example" }],
    [f.issued.secret, { origin: "https://attacker.example" }],
  ] as [string, Record<string, string>][]) {
    assert.ok(
      (
        await handleSync(
          request(secret, "web/preview", undefined, headers),
          f.store,
        )
      ).status >= 400,
    );
  }
  const exported = await f.svc.createToken(admin, "web", { name: "Export" });
  assert.equal(
    (await handleSync(request(exported.secret), f.store)).status,
    401,
  );
  await f.credentials.revoke(admin, "web", f.issued.credential.id);
  assert.equal(
    (await handleSync(request(f.issued.secret), f.store)).status,
    401,
  );
});
test("revocation racing a source-sync commit prevents all copy and history changes", async () => {
  const f = await fixture();
  const identity = await f.credentials.authenticate(request(f.issued.secret));
  const plan = await f.svc.previewUpdate(identity, "web", {
    policy: "source",
    keys: [{ name: "home.title", translations: { en: "Must not save" } }],
  });
  let race = true;
  const wrapped: Store = {
    ...f.store,
    transact: async (changes) => {
      if (
        race &&
        changes.some((change) => change.sk === "KEY#home.title" && change.value)
      ) {
        race = false;
        await f.credentials.revoke(admin, "web", f.issued.credential.id);
      }
      return f.store.transact(changes);
    },
  };
  await assert.rejects(
    new KeyloService(wrapped).applyUpdate(identity, "web", plan.id),
    (error) => error instanceof HttpError && error.status === 401,
  );
  assert.equal(
    (await f.svc.key(admin, "web", "home.title")).translations.en,
    "Old source",
  );
  assert.equal(
    (await f.svc.keyHistory(admin, "web", "home.title", { limit: 25 })).items
      .length,
    1,
  );
});
