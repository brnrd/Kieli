import test from "node:test";
import assert from "node:assert/strict";
import {
  sqliteStore,
  Conflict,
  type Store,
  type Change,
} from "../src/server/store";
import { KieliService } from "../src/server/service";
import { KeyRenames } from "../src/server/key-renames";
import { TranslationMemory } from "../src/server/translation-memory";
import { HttpError } from "../src/server/errors";
import type { Identity, TranslationKey } from "../src/shared";
const admin: Identity = {
  sub: "admin",
  name: "Admin",
  email: "admin@example.test",
  admin: true,
  projects: {},
};
const denied = (status: number) => (e: unknown) =>
  e instanceof HttpError && e.status === status;
async function fixture(wrap: (store: Store) => Store = (store) => store) {
  const store = wrap(await sqliteStore(":memory:")),
    svc = new KieliService(store);
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
    tags: ["shared"],
  });
  const renames = new KeyRenames(store, svc);
  async function preview(key: TranslationKey, name = "greeting") {
    return (await renames.run(admin, "web", key.name, {
      name,
      version: key.version,
    })) as {
      name: string;
      version: number;
      projectVersion: number;
      statsVersion: number;
      references: { name: string; languages: string[] }[];
      affectedKeys: number;
    };
  }
  async function apply(
    key: TranslationKey,
    plan: Awaited<ReturnType<typeof preview>>,
  ) {
    const { references, affectedKeys, ...input } = plan;
    return (await renames.run(
      admin,
      "web",
      key.name,
      input,
      true,
    )) as TranslationKey;
  }
  return { store, svc, key, renames, preview, apply };
}
test("rename preserves stable identity, all history, metadata, freshness and counters", async () => {
  const { svc, key, preview, apply, store } = await fixture();
  const before = await svc.summary(admin, "web");
  const plan = await preview(key);
  assert.equal(plan.affectedKeys, 1);
  const renamed = await apply(key, plan);
  assert.equal(renamed.id, key.id);
  assert.deepEqual(renamed.translations, key.translations);
  assert.deepEqual(renamed.tags, key.tags);
  assert.deepEqual(renamed.outdatedLanguages, key.outdatedLanguages);
  assert.equal(renamed.createdAt, key.createdAt);
  assert.equal(renamed.sourceContext, key.sourceContext);
  assert.equal(renamed.version, key.version + 1);
  await assert.rejects(svc.key(admin, "web", "hello"), denied(404));
  const history = await svc.keyHistory(admin, "web", "greeting", { limit: 25 });
  assert.equal(history.items.length, 2);
  assert.equal(history.items[0]!.origin, "rename");
  assert.equal(history.items[0]!.before!.name, "hello");
  assert.equal(history.items[0]!.after!.name, "greeting");
  assert.deepEqual(await store.list("PROJECT#web", "TRASH#"), []);
  assert.deepEqual(await svc.summary(admin, "web"), {
    ...before,
    version: before.version + 1,
  });
  const memory = await new TranslationMemory(store).lookup(admin, "web", {
    source: "Hello",
    language: "fr",
  });
  assert.ok(memory.items.some((item) => item.text === "Bonjour"));
});
test("rewrites exact references in every language, rebases transitive current freshness, retains outdated copy", async () => {
  const { svc, key, preview, apply } = await fixture();
  await svc.createKey(admin, "web", {
    name: "hello.other",
    translations: { en: "Other", fr: "Autre" },
  });
  const linked = await svc.createKey(admin, "web", {
    name: "linked",
    translations: { en: "[%key:hello%] world", fr: "[%key:hello%] monde" },
  });
  const transitive = await svc.createKey(admin, "web", {
    name: "transitive",
    translations: { en: "[%key:linked%]", fr: "[%key:linked%]" },
  });
  const outdated = await svc.createKey(admin, "web", {
    name: "outdated",
    translations: { en: "[%key:hello%]", fr: "Bonjour" },
  });
  await svc.updateKey(admin, "web", "outdated", {
    version: outdated.version,
    translations: { en: "[%key:hello%]!" },
  });
  const beforeStats = await svc.summary(admin, "web");
  const plan = await preview(key);
  assert.equal(plan.references.length, 2);
  assert.equal(plan.affectedKeys, 4);
  await apply(key, plan);
  for (const old of [linked, transitive]) {
    const current = await svc.key(admin, "web", old.name);
    assert.deepEqual(current.outdatedLanguages, []);
    assert.equal(current.version, old.version + 1);
  }
  const changed = await svc.key(admin, "web", "linked");
  assert.equal(changed.translations.fr, "[%key:greeting%] monde");
  assert.equal(changed.sourceRevision, linked.sourceRevision);
  assert.deepEqual(
    (await svc.key(admin, "web", "outdated")).outdatedLanguages,
    ["fr"],
  );
  assert.deepEqual(await svc.summary(admin, "web"), {
    ...beforeStats,
    version: beforeStats.version + 1,
  });
  assert.equal((await svc.key(admin, "web", "hello.other")).version, 1);
});
test("only signed-in managers can preview or apply", async () => {
  const { key, renames } = await fixture();
  for (const identity of [
    { ...admin, admin: false, projects: { web: "user" as const } },
    { ...admin, admin: false },
    { ...admin, tokenProject: "web" },
    { ...admin, sync: {} as Identity["sync"] },
    { ...admin, mcp: {} as Identity["mcp"] },
  ])
    for (const apply of [false, true])
      await assert.rejects(
        renames.run(
          identity,
          "web",
          "hello",
          { name: "greeting", version: key.version },
          apply,
        ),
        denied(403),
      );
});
test("rejects collisions, missing preview, invalid names and reference capture", async () => {
  const { svc, key, renames } = await fixture();
  await svc.createKey(admin, "web", {
    name: "existing",
    translations: { en: "Existing" },
  });
  await assert.rejects(
    renames.run(admin, "web", "hello", {
      name: "existing",
      version: key.version,
    }),
    denied(409),
  );
  await assert.rejects(
    renames.run(admin, "web", "hello", { name: "hello", version: key.version }),
    denied(400),
  );
  await assert.rejects(
    renames.run(
      admin,
      "web",
      "hello",
      { name: "greeting", version: key.version },
      true,
    ),
    Conflict,
  );
  for (const name of ["bad/name", "__proto__.name", "a..b"])
    await assert.rejects(
      renames.run(admin, "web", "hello", { name, version: key.version }),
    );
  // Simulate a legacy unresolved reference without passing normal graph validation.
  const store = await sqliteStore(":memory:");
  const wrappedSvc = new KieliService(store);
  await wrappedSvc.createProject(admin, {
    id: "web",
    name: "Web",
    sourceLanguage: "en",
    languages: [{ code: "en", name: "English" }],
  });
  const original = await wrappedSvc.createKey(admin, "web", {
    name: "hello",
    translations: { en: "Hello" },
  });
  await store.put("PROJECT#web", "KEY#broken", {
    ...original,
    name: "broken",
    translations: { en: "[%key:greeting%]" },
  });
  await assert.rejects(
    new KeyRenames(store, wrappedSvc).run(admin, "web", "hello", {
      name: "greeting",
      version: original.version,
    }),
    denied(409),
  );
});
test("stale preview cannot miss a newly created reference or project settings change", async () => {
  const { svc, key, preview, apply } = await fixture();
  const plan = await preview(key);
  await svc.createKey(admin, "web", {
    name: "new.link",
    translations: { en: "[%key:hello%]" },
  });
  await assert.rejects(apply(key, plan), Conflict);
  assert.equal((await svc.key(admin, "web", "hello")).name, "hello");
  const next = await preview(key);
  const project = await svc.project(admin, "web");
  const { createdAt, updatedAt, ...settings } = project;
  await svc.updateProject(admin, "web", { ...settings, name: "Changed" });
  await assert.rejects(apply(key, next), Conflict);
});
test("a race at transaction commit rolls back every rename write", async () => {
  let intercept: (() => Promise<void>) | undefined;
  const { svc, key, preview, apply } = await fixture((store) => ({
    ...store,
    async transact(changes: Change[]) {
      if (
        intercept &&
        changes.some((change) => change.sk.startsWith("KEY_GENERATION#hello"))
      ) {
        const action = intercept;
        intercept = undefined;
        await action();
      }
      return store.transact(changes);
    },
  }));
  const plan = await preview(key);
  intercept = async () => {
    await svc.updateKey(admin, "web", "hello", {
      version: key.version,
      translations: { en: "Changed" },
    });
  };
  await assert.rejects(apply(key, plan), Conflict);
  assert.equal(
    (await svc.key(admin, "web", "hello")).translations.en,
    "Changed",
  );
  await assert.rejects(svc.key(admin, "web", "greeting"), denied(404));
});
test("name generation fences reject stale editors after renaming and recreation", async () => {
  const { svc, key, preview, apply } = await fixture();
  await apply(key, await preview(key));
  const recreated = await svc.createKey(admin, "web", {
    name: "hello",
    translations: { en: "New identity" },
  });
  assert.ok(recreated.version > key.version);
  assert.notEqual(recreated.id, key.id);
  await assert.rejects(
    svc.updateKey(admin, "web", "hello", {
      version: key.version,
      translations: { en: "Stale" },
    }),
    Conflict,
  );
  await assert.rejects(
    preview(await svc.key(admin, "web", "greeting"), "hello"),
    denied(409),
  );
});
test("oversized renames reject before writes", async () => {
  const { svc, key, preview } = await fixture();
  for (let i = 0; i < 60; i++)
    await svc.createKey(admin, "web", {
      name: `linked.${i}`,
      translations: { en: "[%key:hello%]", fr: "[%key:hello%]" },
    });
  await assert.rejects(preview(key), denied(413));
  assert.equal((await svc.key(admin, "web", "hello")).id, key.id);
});
test("older previous-translation suggestions survive multiple renames and old-name reuse", async () => {
  const { svc, key, preview, apply, store } = await fixture();
  const edited = await svc.updateKey(admin, "web", "hello", {
    version: key.version,
    translations: { en: "Hi", fr: "Salut" },
  });
  const renamed = await apply(edited, await preview(edited));
  await apply(renamed, await preview(renamed, "welcome"));
  await svc.createKey(admin, "web", {
    name: "hello",
    translations: { en: "Different" },
  });
  const memory = await new TranslationMemory(store).lookup(admin, "web", {
    source: "Hello",
    language: "fr",
  });
  assert.equal(memory.items[0]!.text, "Bonjour");
  assert.equal(memory.items[0]!.keyName, "hello"); // Historical provenance stays accurate.
});
test("legacy identity and Apple native metadata survive a rename", async () => {
  const { svc, store, renames, preview, apply } = await fixture();
  const plural = await svc.createKey(admin, "web", {
    name: "count",
    plural: true,
    translations: {
      en: "{count, plural, one {# item} other {# items}}",
      fr: "{count, plural, one {# article} other {# articles}}",
    },
    applePluralTypes: { en: "lld", fr: "ld" },
  });
  const raw = await store.get<TranslationKey>("PROJECT#web", "KEY#count");
  const { id, ...legacy } = raw!;
  await store.put("PROJECT#web", "KEY#count", legacy, plural.version);
  const plan = await preview(plural, "items");
  const renamed = await apply(plural, plan);
  assert.deepEqual(renamed.applePluralTypes, { en: "lld", fr: "ld" });
  assert.deepEqual(renamed.translations, plural.translations);
  assert.ok(renamed.id);
  await assert.rejects(
    renames.run(admin, "web", "count", {
      name: "items",
      version: plural.version,
    }),
    denied(404),
  );
});
