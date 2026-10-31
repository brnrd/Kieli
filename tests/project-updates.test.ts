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
const user: Identity = {
  ...admin,
  sub: "user",
  admin: false,
  projects: { web: "user" },
};
async function fixture() {
  const store = await sqliteStore(":memory:"),
    svc = new KeyloService(store);
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
    name: "greeting",
    namespace: "home",
    description: "Keep context",
    tags: ["keep"],
    translations: { en: "Hello", fr: "Bonjour" },
  });
  return { store, svc };
}
test("merge preview is non-mutating and preserves populated targets and metadata", async () => {
  const { svc } = await fixture();
  const plan = await svc.previewUpdate(admin, "web", {
    keys: [
      { name: "greeting", translations: { en: "Goodbye", fr: "Au revoir" } },
      { name: "new.key", translations: { en: "New", fr: "Nouveau" } },
    ],
  });
  assert.equal(plan.created, 1);
  assert.equal(plan.updated, 1);
  assert.deepEqual(plan.entries[0]!.preserved, ["fr"]);
  assert.equal(
    (await svc.key(admin, "web", "greeting")).translations.en,
    "Hello",
  );
  const result = await svc.applyUpdate(admin, "web", plan.id);
  assert.equal(result.replayed, false);
  let key = await svc.key(admin, "web", "greeting");
  assert.equal(key.translations.fr, "Bonjour");
  assert.equal(key.namespace, "home");
  assert.deepEqual(key.tags, ["keep"]);
  assert.equal(key.description, "Keep context");
  assert.deepEqual(key.outdatedLanguages, ["fr"]);
  assert.equal((await svc.applyUpdate(admin, "web", plan.id)).replayed, true);
  assert.equal((await svc.key(admin, "web", "greeting")).version, key.version);
  const repeated = await svc.previewUpdate(admin, "web", {
    keys: [
      { name: "greeting", translations: { en: "Goodbye", fr: "Au revoir" } },
    ],
  });
  assert.equal(repeated.unchanged, 1);
  await svc.applyUpdate(admin, "web", repeated.id);
  key = await svc.key(admin, "web", "greeting");
  assert.deepEqual(key.outdatedLanguages, ["fr"]);
});
test("explicit overwrite and source-only policies have separate bounded effects", async () => {
  const { svc } = await fixture();
  const source = await svc.previewUpdate(admin, "web", {
    policy: "source",
    keys: [
      { name: "greeting", translations: { en: "Welcome", fr: "Bienvenue" } },
    ],
  });
  await svc.applyUpdate(admin, "web", source.id);
  assert.equal(
    (await svc.key(admin, "web", "greeting")).translations.fr,
    "Bonjour",
  );
  const overwrite = await svc.previewUpdate(admin, "web", {
    policy: "overwrite",
    keys: [
      { name: "greeting", translations: { en: "Welcome", fr: "Bienvenue" } },
    ],
  });
  await svc.applyUpdate(admin, "web", overwrite.id);
  const key = await svc.key(admin, "web", "greeting");
  assert.equal(key.translations.fr, "Bienvenue");
  assert.deepEqual(key.outdatedLanguages, []);
  assert.equal(
    (await svc.keyHistory(admin, "web", "greeting", { limit: 1 })).items[0]!
      .origin,
    "import",
  );
});
test("changed keys, project settings and another actor cannot consume an old preview", async () => {
  const { svc } = await fixture();
  const plan = await svc.previewUpdate(admin, "web", {
    keys: [{ name: "greeting", translations: { en: "Goodbye" } }],
  });
  let key = await svc.key(admin, "web", "greeting");
  await svc.updateKey(admin, "web", key.name, {
    version: key.version,
    translations: { fr: "Salut" },
  });
  await assert.rejects(svc.applyUpdate(admin, "web", plan.id), Conflict);
  key = await svc.key(admin, "web", "greeting");
  assert.equal(key.translations.en, "Hello");
  await assert.rejects(
    svc.applyUpdate({ ...admin, sub: "different" }, "web", plan.id),
    (error) => error instanceof HttpError && error.status === 404,
  );
  await assert.rejects(
    svc.previewUpdate(user, "web", {
      keys: [{ name: "greeting", translations: { fr: "Test" } }],
    }),
    (error) => error instanceof HttpError && error.status === 403,
  );
});
test("invalid batches are rejected before a plan is stored, and empty values never erase copy", async () => {
  const { svc, store } = await fixture();
  await assert.rejects(
    svc.previewUpdate(admin, "web", {
      keys: [{ name: "unknown", translations: { fr: "No source" } }],
    }),
  );
  await assert.rejects(
    svc.previewUpdate(admin, "web", {
      keys: [{ name: "greeting", translations: { de: "Unknown locale" } }],
    }),
  );
  assert.equal((await store.list("PROJECT#web", "UPDATE_PLAN#")).length, 0);
  const empty = await svc.previewUpdate(admin, "web", {
    policy: "overwrite",
    keys: [{ name: "greeting", translations: { en: "", fr: "" } }],
  });
  assert.equal(empty.unchanged, 1);
  await svc.applyUpdate(admin, "web", empty.id);
  assert.equal(
    (await svc.key(admin, "web", "greeting")).translations.fr,
    "Bonjour",
  );
});
test("concurrent applications commit one change and replay the same immutable receipt", async () => {
  const { svc } = await fixture();
  const plan = await svc.previewUpdate(admin, "web", {
    keys: [{ name: "greeting", translations: { en: "Welcome" } }],
  });
  const results = await Promise.all([
    svc.applyUpdate(admin, "web", plan.id),
    svc.applyUpdate(admin, "web", plan.id),
  ]);
  assert.equal(results.filter((result) => !result.replayed).length, 1);
  assert.equal((await svc.key(admin, "web", "greeting")).version, 2);
  assert.equal(
    (await svc.keyHistory(admin, "web", "greeting", { limit: 25 })).items
      .length,
    2,
  );
});

test("references crossing batches are flagged and revalidated when dependencies are applied", async () => {
  const { svc } = await fixture();
  const dependent = await svc.previewUpdate(admin, "web", {
    keys: [
      {
        name: "dependent",
        translations: {
          en: "Use [%key:parent%]",
          fr: "Utiliser [%key:parent%]",
        },
      },
    ],
  });
  assert.deepEqual(dependent.unresolvedReferences, ["parent"]);
  await assert.rejects(
    svc.applyUpdate(admin, "web", dependent.id),
    (error) => error instanceof HttpError && error.status === 422,
  );
  const parent = await svc.previewUpdate(admin, "web", {
    keys: [{ name: "parent", translations: { en: "Parent", fr: "Parent" } }],
  });
  await svc.applyUpdate(admin, "web", parent.id);
  await svc.applyUpdate(admin, "web", dependent.id);
  assert.equal(
    (await svc.key(admin, "web", "dependent")).resolvedTranslations?.en,
    "Use Parent",
  );
});

test("ordinary source updates do not load the entire project key collection", async () => {
  const { store } = await fixture();
  let collections = 0;
  const wrapped = {
    ...store,
    list: async <T>(pk: string, prefix: string) => {
      if (prefix.endsWith("KEY#")) collections++;
      return store.list<T>(pk, prefix);
    },
  };
  const svc = new KeyloService(wrapped);
  const plan = await svc.previewUpdate(admin, "web", {
    policy: "source",
    keys: [{ name: "greeting", translations: { en: "Updated" } }],
  });
  await svc.applyUpdate(admin, "web", plan.id);
  assert.equal(collections, 0);
});
