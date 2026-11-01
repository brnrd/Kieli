import test from "node:test";
import assert from "node:assert/strict";
import { sqliteStore, Conflict } from "../src/server/store";
import { KeyloService } from "../src/server/service";
import type { Identity } from "../src/shared";
import { HttpError } from "../src/server/errors";
const admin: Identity = {
  sub: "admin",
  name: "Admin",
  email: "admin@example.com",
  admin: true,
  projects: {},
};
const user: Identity = { ...admin, admin: false, projects: { web: "user" } };
async function fixture() {
  const store = await sqliteStore(":memory:");
  const svc = new KeyloService(store);
  await svc.createProject(admin, {
    id: "web",
    name: "Web",
    sourceLanguage: "en",
    languages: [
      { code: "en", name: "English" },
      { code: "fr", name: "French" },
    ],
  });
  const key = await svc.createKey(admin, "web", {
    name: "hello",
    translations: { en: "Hello", fr: "Bonjour" },
  });
  return { store, svc, key };
}
test("history preserves before/after values, stable identity, actor and origin with bounded pagination", async () => {
  const { svc, key } = await fixture();
  const next = await svc.updateKey(user, "web", "hello", {
    version: key.version,
    translations: { fr: "Salut" },
  });
  assert.equal(next.id, key.id);
  const page = await svc.keyHistory(user, "web", "hello", { limit: 1 });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]!.before?.translations.fr, "Bonjour");
  assert.equal(page.items[0]!.after?.translations.fr, "Salut");
  assert.equal(page.items[0]!.actor, "admin");
  assert.equal(page.items[0]!.origin, "browser");
  assert.ok(page.nextCursor);
  assert.equal(
    (
      await svc.keyHistory(user, "web", "hello", {
        limit: 1,
        cursor: page.nextCursor,
      })
    ).items[0]!.before,
    undefined,
  );
});
test("restoring one translation preserves other languages and historical freshness anchors", async () => {
  const { svc, key } = await fixture();
  const changed = await svc.updateKey(user, "web", "hello", {
    version: key.version,
    translations: { fr: "Salut" },
  });
  const event = (await svc.keyHistory(user, "web", "hello", { limit: 10 }))
    .items[0]!;
  const source = await svc.updateKey(admin, "web", "hello", {
    version: changed.version,
    translations: { en: "Goodbye" },
  });
  const current = await svc.updateKey(user, "web", "hello", {
    version: source.version,
    translations: { fr: "Au revoir" },
  });
  const restored = await svc.restoreTranslation(
    user,
    "web",
    "hello",
    event.id,
    {
      version: current.version,
      language: "fr",
      side: "before",
      expectedSourceContext: current.sourceContext,
    },
  );
  assert.equal(restored.applePluralTypes, undefined);
  assert.equal(restored.translations.en, "Goodbye");
  assert.equal(restored.translations.fr, "Bonjour");
  assert.deepEqual(restored.outdatedLanguages, ["fr"]);
  assert.equal(
    (await svc.keyHistory(admin, "web", "hello", { limit: 1 })).items[0]!
      .origin,
    "restore",
  );
  await assert.rejects(
    svc.restoreTranslation(user, "web", "hello", event.id, {
      version: current.version,
      language: "fr",
      side: "before",
    }),
    Conflict,
  );
  await assert.rejects(
    svc.restoreTranslation(user, "web", "hello", event.id, {
      version: restored.version,
      language: "en",
      side: "before",
    }),
    (error) => error instanceof HttpError && error.status === 403,
  );
});
test("deleted keys are recoverable without overwriting a name or reviving stale edit versions", async () => {
  const { svc, key } = await fixture();
  await svc.deleteKey(admin, "web", "hello", key.version);
  const trash = await svc.deletedKeys(admin, "web", { limit: 25 });
  assert.equal(trash.items.length, 1);
  assert.equal(trash.items[0]!.id, key.id);
  await assert.rejects(
    svc.deletedKeys(user, "web", { limit: 25 }),
    (error) => error instanceof HttpError && error.status === 403,
  );
  const recreated = await svc.createKey(admin, "web", {
    name: "hello",
    translations: { en: "Another", fr: "Autre" },
  });
  assert.notEqual(recreated.id, key.id);
  assert.ok(recreated.version > key.version);
  await assert.rejects(
    svc.restoreDeletedKey(admin, "web", key.id!, { version: 1 }),
    Conflict,
  );
  await assert.rejects(
    svc.updateKey(admin, "web", "hello", {
      version: key.version,
      translations: { en: "Stale editor" },
    }),
    Conflict,
  );
  await svc.deleteKey(admin, "web", "hello", recreated.version);
  const restored = await svc.restoreDeletedKey(admin, "web", key.id!, {
    version: 1,
  });
  assert.equal(restored.id, key.id);
  assert.equal(restored.translations.en, "Hello");
  assert.ok(restored.version > recreated.version);
  assert.deepEqual(restored.outdatedLanguages, []);
  await svc.deleteKey(admin, "web", "hello", restored.version);
  assert.equal(
    (await svc.deletedKeys(admin, "web", { limit: 25 })).items.length,
    2,
  );
});
test("expired trash cannot be restored and invalid writes do not append history", async () => {
  const { svc, key, store } = await fixture();
  const count = (await svc.keyHistory(admin, "web", "hello", { limit: 25 }))
    .items.length;
  await assert.rejects(
    svc.updateKey(admin, "web", "hello", {
      version: 99,
      translations: { fr: "Invalid" },
    }),
    Conflict,
  );
  assert.equal(
    (await svc.keyHistory(admin, "web", "hello", { limit: 25 })).items.length,
    count,
  );
  await svc.deleteKey(admin, "web", "hello", key.version);
  const record = await store.get<any>("PROJECT#web", `TRASH#${key.id}`);
  await store.put(
    "PROJECT#web",
    `TRASH#${key.id}`,
    { ...record, version: 2, ttl: 0 },
    1,
  );
  assert.equal(
    (await svc.deletedKeys(admin, "web", { limit: 25 })).items.length,
    0,
  );
  await assert.rejects(
    svc.restoreDeletedKey(admin, "web", key.id!, { version: 2 }),
    (error) => error instanceof HttpError && error.status === 404,
  );
});
