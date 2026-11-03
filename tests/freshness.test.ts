import test from "node:test";
import assert from "node:assert/strict";
import { sqliteStore, Conflict } from "../src/server/store";
import { KieliService } from "../src/server/service";
import { ProjectHistory } from "../src/server/project-history";
import type { Identity } from "../src/shared";
const admin: Identity = {
  sub: "admin",
  name: "Admin",
  email: "admin@example.com",
  admin: true,
  projects: {},
};
const user: Identity = { ...admin, admin: false, projects: { web: "user" } };
const settings = {
  id: "web",
  name: "Web",
  sourceLanguage: "en",
  languages: [
    { code: "en", name: "English" },
    { code: "fr", name: "French" },
    { code: "nl", name: "Dutch" },
  ],
};
async function fixture() {
  const store = await sqliteStore(":memory:");
  const svc = new KieliService(store);
  await svc.createProject(admin, settings);
  const key = await svc.createKey(admin, "web", {
    name: "subscription",
    translations: { en: "Cancel subscription", fr: "Annuler", nl: "Annuleren" },
  });
  return { store, svc, key };
}
test("source edits retain target copy but mark it outdated and update filters/counters", async () => {
  const { svc, key } = await fixture();
  const next = await svc.updateKey(admin, "web", key.name, {
    version: key.version,
    translations: { en: "Pause subscription", fr: "Annuler", nl: "Annuleren" },
  });
  assert.equal(next.sourceRevision, 2);
  assert.deepEqual(next.outdatedLanguages, ["fr", "nl"]);
  assert.equal(next.translations.fr, "Annuler");
  assert.equal(
    (await svc.keyPage(admin, "web", { limit: 10, status: "outdated" })).items
      .length,
    1,
  );
  assert.equal(
    (await svc.keyPage(admin, "web", { limit: 10, status: "missing" })).items
      .length,
    0,
  );
  assert.equal(
    (await svc.keyPage(admin, "web", { limit: 10, status: "complete" })).items
      .length,
    0,
  );
  const stats = await svc.summary(admin, "web");
  assert.equal(stats.byLanguage.fr, undefined);
  assert.equal(stats.outdatedByLanguage?.fr, 1);
  await svc.updateKey(user, "web", key.name, {
    version: next.version,
    translations: { fr: "Suspendre" },
  });
  const current = await svc.key(admin, "web", key.name);
  assert.deepEqual(current.outdatedLanguages, ["nl"]);
  assert.equal((await svc.summary(admin, "web")).byLanguage.fr, 1);
});
test("metadata changes leave stale translations stale, explicit resaving can retain unchanged copy", async () => {
  const { svc, key } = await fixture();
  const stale = await svc.updateKey(admin, "web", key.name, {
    version: key.version,
    translations: { en: "Pause" },
  });
  const meta = await svc.updateKey(admin, "web", key.name, {
    version: stale.version,
    description: "Updated context",
    translations: {},
  });
  assert.equal(meta.sourceRevision, 2);
  assert.deepEqual(meta.outdatedLanguages, ["fr", "nl"]);
  const saved = await svc.updateKey(user, "web", key.name, {
    version: meta.version,
    expectedSourceContext: meta.sourceContext,
    translations: { fr: meta.translations.fr! },
  });
  assert.deepEqual(saved.outdatedLanguages, ["nl"]);
  await assert.rejects(
    svc.updateKey(user, "web", key.name, {
      version: meta.version,
      translations: { fr: "Late" },
    }),
    Conflict,
  );
});
test("source revisions prevent reverting the source from silently accepting old translations", async () => {
  const { svc, key } = await fixture();
  let next = await svc.updateKey(admin, "web", key.name, {
    version: key.version,
    translations: { en: "Pause" },
  });
  next = await svc.updateKey(admin, "web", key.name, {
    version: next.version,
    translations: { en: "Cancel subscription" },
  });
  assert.equal(next.sourceRevision, 3);
  assert.deepEqual(next.outdatedLanguages, ["fr", "nl"]);
});
test("linked source edits invalidate dependent translations and stale source-context saves conflict", async () => {
  const { svc } = await fixture();
  const dependent = await svc.createKey(admin, "web", {
    name: "confirm",
    translations: {
      en: "Please [%key:subscription%]",
      fr: "Veuillez annuler",
      nl: "Graag annuleren",
    },
  });
  const source = await svc.key(admin, "web", "subscription");
  await svc.updateKey(admin, "web", source.name, {
    version: source.version,
    translations: { en: "Pause" },
  });
  const stale = await svc.key(admin, "web", dependent.name);
  assert.deepEqual(stale.outdatedLanguages, ["fr", "nl"]);
  await assert.rejects(
    svc.updateKey(user, "web", dependent.name, {
      version: stale.version,
      expectedSourceContext: dependent.sourceContext,
      translations: { fr: "Old context" },
    }),
    Conflict,
  );
  const saved = await svc.updateKey(user, "web", dependent.name, {
    version: stale.version,
    expectedSourceContext: stale.sourceContext,
    translations: { fr: "Veuillez suspendre" },
  });
  assert.deepEqual(saved.outdatedLanguages, ["nl"]);
  assert.equal((await svc.summary(admin, "web")).outdatedKeys, 2);
});
test("legacy keys remain current until the source changes, including unanchored dependencies", async () => {
  const { svc, store } = await fixture();
  const legacy = {
    name: "legacy",
    namespace: "general",
    tags: [],
    description: "",
    translations: { en: "Legacy", fr: "Ancien", nl: "Oud" },
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    updatedBy: "Old version",
    filledLanguages: ["en", "fr", "nl"],
  };
  await store.put("PROJECT#web", "KEY#legacy", legacy);
  const stats = await store.get<any>("PROJECT#web", "STATS");
  await store.put(
    "PROJECT#web",
    "STATS",
    { ...stats, messageVersion: 1, version: stats.version + 1 },
    stats.version,
  );
  assert.deepEqual(
    (await svc.key(admin, "web", "legacy")).outdatedLanguages,
    [],
  );
  const changed = await svc.updateKey(admin, "web", "legacy", {
    version: 1,
    translations: { en: "New source" },
  });
  assert.deepEqual(changed.outdatedLanguages, ["fr", "nl"]);
});
test("snapshots preserve freshness metadata and outdated translations cannot be published", async () => {
  const { svc, key, store } = await fixture();
  const history = new ProjectHistory(store);
  const stale = await svc.updateKey(admin, "web", key.name, {
    version: key.version,
    translations: { en: "Pause" },
  });
  const snapshot = await history.create(admin, "web", "Stale");
  await assert.rejects(
    history.publish(admin, "web", {
      label: "Unsafe",
      channel: "production",
      expectedHeadVersion: 0,
    }),
  );
  await svc.updateKey(user, "web", key.name, {
    version: stale.version,
    translations: { fr: "Suspendre", nl: "Pauzeren" },
  });
  await history.restore(
    admin,
    "web",
    snapshot.id,
    (await svc.project(admin, "web")).version,
  );
  assert.deepEqual((await svc.key(admin, "web", key.name)).outdatedLanguages, [
    "fr",
    "nl",
  ]);
});
