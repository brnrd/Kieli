import test from "node:test";
import assert from "node:assert/strict";
import { ZodError } from "zod";
import { sqliteStore, type Store, type Change } from "../src/server/store";
import { KieliService, completedKeys } from "../src/server/service";
import { BulkMetadata } from "../src/server/bulk-metadata";
import { HttpError } from "../src/server/errors";
import { ProjectHistory } from "../src/server/project-history";
import type { Identity, TranslationKey } from "../src/shared";
process.env.AUTH_MODE = "demo";
const admin: Identity = {
  sub: "admin",
  name: "Admin",
  email: "admin@example.test",
  admin: true,
  projects: {},
};
const manager: Identity = {
  ...admin,
  admin: false,
  sub: "manager",
  projects: { web: "manager" },
};
const user: Identity = { ...manager, sub: "user", projects: { web: "user" } };
const settings = {
  id: "web",
  name: "Web",
  sourceLanguage: "en",
  languages: [
    { code: "en", name: "English" },
    { code: "fr", name: "French", pluralForms: ["one", "other"] },
    { code: "nl", name: "Dutch" },
  ],
};
const denied = (status: number) => (error: unknown) =>
  error instanceof HttpError && error.status === status;
async function fixture(
  count = 3,
  wrap: (store: Store) => Store = (store) => store,
) {
  const store = wrap(await sqliteStore(":memory:")),
    svc = new KieliService(store),
    bulk = new BulkMetadata(store, svc);
  await svc.createProject(admin, settings);
  const keys: TranslationKey[] = [];
  for (let i = 0; i < count; i++)
    keys.push(
      await svc.createKey(manager, "web", {
        name: `key.${String(i).padStart(3, "0")}`,
        namespace: "original",
        tags: ["legacy", "keep"],
        translations: {
          en: `Hello ${i}`,
          fr: `Bonjour ${i}`,
          nl: `Hallo ${i}`,
        },
      }),
    );
  return {
    store,
    svc,
    bulk,
    keys,
    selection: keys.map(({ name, version }) => ({ name, version })),
  };
}
const update = {
  addTags: ["new", "keep"],
  removeTags: ["legacy"],
  namespace: "checkout",
};

test("bulk preview and commit change only metadata, index namespaces/search and record history/audit", async () => {
  const { bulk, svc, store, selection } = await fixture();
  const before = await svc.keys(user, "web");
  const plan = await bulk.preview(manager, "web", {
    keys: selection,
    operation: update,
  });
  assert.equal(plan.changed, 3);
  assert.equal(plan.processed, 0);
  assert.deepEqual(plan.entries[0]!.before, {
    namespace: "original",
    tags: ["legacy", "keep"],
  });
  assert.deepEqual(plan.entries[0]!.after, {
    namespace: "checkout",
    tags: ["keep", "new"],
  });
  assert.deepEqual(await svc.keys(user, "web"), before);
  const result = await bulk.apply(manager, "web", plan.id, { offset: 0 });
  assert.equal(result.updated, 3);
  assert.equal(result.done, true);
  const after = await svc.keys(user, "web");
  for (const [index, key] of after.entries()) {
    assert.deepEqual(key.translations, before[index]!.translations);
    assert.equal(key.id, before[index]!.id);
    assert.equal(key.sourceRevision, before[index]!.sourceRevision);
    assert.deepEqual(key.translationSources, before[index]!.translationSources);
    assert.deepEqual(key.outdatedLanguages, before[index]!.outdatedLanguages);
    assert.equal(key.createdAt, before[index]!.createdAt);
    assert.equal(key.version, before[index]!.version + 1);
    assert.equal(key.updatedBy, "Admin");
    const history = await svc.keyHistory(user, "web", key.name, { limit: 25 });
    assert.equal(history.items[0]!.origin, "metadata");
    assert.deepEqual(
      history.items[0]!.before?.translations,
      history.items[0]!.after?.translations,
    );
  }
  const stats = await svc.summary(user, "web");
  assert.deepEqual(stats.namespaces, { checkout: 3 });
  assert.equal(stats.totalKeys, 3);
  assert.equal(
    (
      await svc.keyPage(user, "web", {
        limit: 25,
        query: "new",
        namespace: "checkout",
      })
    ).items.length,
    3,
  );
  const audits = await store.list<{ action: string }>("AUTH_AUDIT", "");
  assert.equal(
    audits.filter((event) => event.action === "keys.metadata_updated").length,
    1,
  );
  assert.deepEqual(await bulk.status(manager, "web", plan.id), result);
});
test("noop keys are checked and counted without version/history/counter changes", async () => {
  const { bulk, svc, store, selection } = await fixture();
  const plan = await bulk.preview(manager, "web", {
    keys: selection,
    operation: { addTags: ["keep"], removeTags: ["absent"] },
  });
  const before = await store.list("PROJECT#web", "KEY#"),
    stats = await svc.summary(user, "web");
  const result = await bulk.apply(manager, "web", plan.id, { offset: 0 });
  assert.equal(result.updated, 0);
  assert.equal(result.skipped, 3);
  assert.deepEqual(await store.list("PROJECT#web", "KEY#"), before);
  assert.deepEqual(await svc.summary(user, "web"), stats);
  assert.equal(
    (await svc.keyHistory(user, "web", selection[0]!.name, { limit: 25 })).items
      .length,
    1,
  );
});
test("metadata endpoints require signed-in project managers and bind previews to actor, project and mode", async () => {
  const { bulk, svc, selection } = await fixture();
  const plan = await bulk.preview(manager, "web", {
    keys: selection,
    operation: update,
  });
  for (const identity of [
    user,
    { ...manager, projects: {} },
    { ...admin, tokenProject: "web" },
    { ...admin, mcp: {} as Identity["mcp"] },
    { ...admin, sync: {} as Identity["sync"] },
  ]) {
    await assert.rejects(
      bulk.preview(identity, "web", { keys: selection, operation: update }),
      denied(403),
    );
    await assert.rejects(
      bulk.apply(identity, "web", plan.id, { offset: 0 }),
      denied(403),
    );
    await assert.rejects(bulk.status(identity, "web", plan.id), denied(403));
  }
  await assert.rejects(
    bulk.apply(admin, "web", plan.id, { offset: 0 }),
    denied(404),
  );
  await assert.rejects(
    bulk.apply(
      { ...manager, projects: { other: "manager" } },
      "other",
      plan.id,
      { offset: 0 },
    ),
    denied(404),
  );
  process.env.AUTH_MODE = "local";
  try {
    await assert.rejects(
      bulk.apply(manager, "web", plan.id, { offset: 0 }),
      denied(404),
    );
  } finally {
    process.env.AUTH_MODE = "demo";
  }
  await svc.setProjectArchived(manager, "web", { version: 1, archived: true });
  await assert.rejects(
    bulk.preview(manager, "web", { keys: selection, operation: update }),
    denied(409),
  );
  await assert.rejects(
    bulk.apply(manager, "web", plan.id, { offset: 0 }),
    denied(409),
  );
  assert.equal((await bulk.status(manager, "web", plan.id)).processed, 0);
});
test("input rejects duplicates, missing/stale keys, conflicting tags, overflow and extra copy fields", async () => {
  const { bulk, svc, selection } = await fixture();
  for (const operation of [
    {},
    { addTags: ["same"], removeTags: ["same"] },
    { addTags: ["new", "new"] },
    { namespace: "" },
    { namespace: "constructor" },
    { translations: { en: "Changed" } },
    { addTags: ["x".repeat(31)] },
  ])
    await assert.rejects(
      bulk.preview(manager, "web", { keys: selection, operation }),
      ZodError,
    );
  await assert.rejects(
    bulk.preview(manager, "web", {
      keys: [...selection, selection[0]],
      operation: update,
    }),
    denied(400),
  );
  await assert.rejects(
    bulk.preview(manager, "web", {
      keys: [{ name: "missing", version: 1 }],
      operation: update,
    }),
    denied(409),
  );
  await assert.rejects(
    bulk.preview(manager, "web", {
      keys: selection,
      operation: { addTags: Array.from({ length: 12 }, (_, i) => `tag${i}`) },
    }),
    denied(400),
  );
  await svc.updateKey(manager, "web", selection[0]!.name, {
    version: 1,
    translations: {},
    tags: ["changed"],
  });
  await assert.rejects(
    bulk.preview(manager, "web", { keys: selection, operation: update }),
    denied(409),
  );
  await assert.rejects(
    bulk.preview(manager, "web", { keys: [], operation: update }),
    ZodError,
  );
});
test("batches expose durable progress; conflicts save none of the failed batch and repreview affects only remaining keys", async () => {
  const { bulk, svc, selection } = await fixture(23);
  const plan = await bulk.preview(manager, "web", {
    keys: selection,
    operation: update,
  });
  const first = await bulk.apply(manager, "web", plan.id, { offset: 0 });
  assert.equal(first.processed, 10);
  assert.equal(first.updated, 10);
  assert.equal(first.done, false);
  await svc.updateKey(manager, "web", selection[14]!.name, {
    version: 1,
    translations: {},
    tags: ["concurrent"],
  });
  await assert.rejects(
    bulk.apply(manager, "web", plan.id, { offset: 10 }),
    denied(409),
  );
  assert.equal((await bulk.status(manager, "web", plan.id)).processed, 10);
  for (const item of selection.slice(10))
    assert.equal((await svc.key(user, "web", item.name)).namespace, "original");
  const remaining = await Promise.all(
    selection.slice(10).map(async ({ name }) => {
      const key = await svc.key(user, "web", name);
      return { name, version: key.version };
    }),
  );
  const second = await bulk.preview(manager, "web", {
    keys: remaining,
    operation: update,
  });
  const partial = await bulk.apply(manager, "web", second.id, { offset: 0 });
  const done = await bulk.apply(manager, "web", second.id, {
    offset: partial.processed,
  });
  assert.equal(done.processed, 13);
  assert.equal(done.done, true);
  assert.equal((await svc.key(user, "web", selection[0]!.name)).version, 2);
  assert.deepEqual((await svc.key(user, "web", selection[14]!.name)).tags, [
    "concurrent",
    "new",
    "keep",
  ]);
});
test("lost responses and concurrent retries of the same offset cannot double apply or advance another batch", async () => {
  const { bulk, svc, selection } = await fixture(23);
  const plan = await bulk.preview(manager, "web", {
    keys: selection,
    operation: update,
  });
  await assert.rejects(
    bulk.apply(manager, "web", plan.id, { offset: 10 }),
    denied(409),
  );
  const results = await Promise.all([
    bulk.apply(manager, "web", plan.id, { offset: 0 }),
    bulk.apply(manager, "web", plan.id, { offset: 0 }),
  ]);
  assert.ok(results.every((result) => result.processed === 10));
  assert.equal(
    (await svc.keyHistory(user, "web", selection[0]!.name, { limit: 25 })).items
      .length,
    2,
  );
  const receipt = await bulk.status(manager, "web", plan.id);
  assert.deepEqual(
    await bulk.apply(manager, "web", plan.id, { offset: 0 }),
    receipt,
  );
  await bulk.apply(manager, "web", plan.id, { offset: 10 });
  const done = await bulk.apply(manager, "web", plan.id, { offset: 20 });
  assert.equal(done.processed, 23);
  assert.deepEqual(
    await bulk.apply(manager, "web", plan.id, { offset: 20 }),
    done,
  );
});
test("concurrent archive, key edit and counter changes fence whole batches without lost updates", async () => {
  let intercept: (() => Promise<unknown>) | undefined;
  const { bulk, svc, selection } = await fixture(3, (store) => ({
    ...store,
    async transact(changes: Change[]) {
      if (
        intercept &&
        changes.some(
          (change) =>
            change.sk.startsWith("METADATA_PLAN#") && change.expectedVersion,
        )
      ) {
        const action = intercept;
        intercept = undefined;
        await action();
      }
      return store.transact(changes);
    },
  }));
  const plan = await bulk.preview(manager, "web", {
    keys: selection,
    operation: update,
  });
  intercept = () =>
    svc.createKey(manager, "web", {
      name: "concurrent",
      namespace: "other",
      translations: { en: "New" },
    });
  await bulk.apply(manager, "web", plan.id, { offset: 0 });
  assert.deepEqual((await svc.summary(user, "web")).namespaces, {
    checkout: 3,
    other: 1,
  });
  const latest = await Promise.all(
    selection.map(async ({ name }) => {
      const key = await svc.key(user, "web", name);
      return { name, version: key.version };
    }),
  );
  const edit = await bulk.preview(manager, "web", {
    keys: latest,
    operation: { addTags: ["again"] },
  });
  intercept = () =>
    svc.updateKey(user, "web", latest[1]!.name, {
      version: latest[1]!.version,
      translations: { fr: "Concurrent" },
    });
  await assert.rejects(
    bulk.apply(manager, "web", edit.id, { offset: 0 }),
    denied(409),
  );
  assert.ok(
    !(await svc.key(user, "web", latest[0]!.name)).tags.includes("again"),
  );
  const archive = await bulk.preview(manager, "web", {
    keys: [latest[0]!],
    operation: { addTags: ["again"] },
  });
  intercept = () =>
    svc.setProjectArchived(manager, "web", { version: 1, archived: true });
  await assert.rejects(
    bulk.apply(manager, "web", archive.id, { offset: 0 }),
    denied(409),
  );
  assert.equal((await bulk.status(manager, "web", archive.id)).processed, 0);
});
test("copy, native metadata and outdated linked/plural freshness survive metadata edits without graph scans", async () => {
  let forbidScan = false;
  const { store, bulk, svc } = await fixture(1, (store) => ({
    ...store,
    async list<T>(pk: string, prefix: string) {
      if (forbidScan && prefix.endsWith("KEY#"))
        throw new Error("Metadata must not load the project graph");
      return store.list<T>(pk, prefix);
    },
  }));
  await svc.createKey(manager, "web", {
    name: "linked",
    translations: {
      en: "[%key:key.000%]",
      fr: "[%key:key.000%]",
      nl: "[%key:key.000%]",
    },
  });
  await svc.createKey(manager, "web", {
    name: "plural",
    plural: true,
    applePluralTypes: { en: "ld", fr: "lld" },
    translations: {
      en: "{n, plural, one {# item} other {# items}}",
      fr: "{n, plural, one {# article} other {# articles}}",
    },
  });
  await svc.updateKey(manager, "web", "key.000", {
    version: 1,
    translations: { en: "Changed" },
  });
  await svc.setLanguageEnabled(manager, "web", "fr", {
    version: 1,
    enabled: false,
  });
  const before = await svc.keys(user, "web"),
    selection = before.map(({ name, version }) => ({ name, version }));
  const stats = await svc.summary(user, "web");
  const plan = await bulk.preview(manager, "web", {
    keys: selection,
    operation: update,
  });
  forbidScan = true;
  await bulk.apply(manager, "web", plan.id, { offset: 0 });
  forbidScan = false;
  for (const old of before) {
    const key = (await store.get<TranslationKey>(
      "PROJECT#web",
      `KEY#${old.name}`,
    ))!;
    for (const field of [
      "translations",
      "applePluralTypes",
      "plural",
      "sourceRevision",
      "translationSources",
      "sourceContext",
      "outdatedLanguages",
      "filledLanguages",
    ] as const)
      assert.deepEqual(key[field], old[field], field);
  }
  const after = await svc.summary(user, "web");
  assert.equal(after.outdatedKeys, stats.outdatedKeys);
  assert.equal(
    completedKeys(after, await svc.project(user, "web")),
    completedKeys(stats, await svc.project(user, "web")),
  );
});
test("deleted/recreated identities, expired plans and project snapshots cannot revive a stale preview", async () => {
  const { store, bulk, svc, selection } = await fixture(1);
  const plan = await bulk.preview(manager, "web", {
    keys: selection,
    operation: update,
  });
  await svc.deleteKey(manager, "web", selection[0]!.name, 1);
  await svc.createKey(manager, "web", {
    name: selection[0]!.name,
    translations: { en: "New identity" },
  });
  await assert.rejects(
    bulk.apply(manager, "web", plan.id, { offset: 0 }),
    denied(409),
  );
  const raw = (await store.get<any>(
    "PROJECT#web",
    `METADATA_PLAN#${plan.id}`,
  ))!;
  await store.put(
    "PROJECT#web",
    `METADATA_PLAN#${plan.id}`,
    { ...raw, ttl: 1, version: raw.version + 1 },
    raw.version,
  );
  await assert.rejects(bulk.status(manager, "web", plan.id), denied(404));
  const current = await svc.key(user, "web", selection[0]!.name);
  const next = await bulk.preview(manager, "web", {
    keys: [{ name: current.name, version: current.version }],
    operation: update,
  });
  const history = new ProjectHistory(store),
    snapshot = await history.create(manager, "web", "Before");
  await history.restore(manager, "web", snapshot.id, 1);
  await assert.rejects(
    bulk.apply(manager, "web", next.id, { offset: 0 }),
    denied(409),
  );
});
test("one hundred keys and large native copy fit bounded transactions with accurate progress", async () => {
  const transactions: Change[][] = [];
  const { bulk, svc, selection } = await fixture(100, (store) => ({
    ...store,
    async transact(changes: Change[]) {
      transactions.push(changes);
      return store.transact(changes);
    },
  }));
  await assert.rejects(
    bulk.preview(manager, "web", {
      keys: [...selection, { name: "extra", version: 1 }],
      operation: update,
    }),
    ZodError,
  );
  const plan = await bulk.preview(manager, "web", {
    keys: selection,
    operation: update,
  });
  let result = plan;
  while (!result.done)
    result = await bulk.apply(manager, "web", plan.id, {
      offset: result.processed,
    });
  assert.equal(result.updated, 100);
  assert.deepEqual((await svc.summary(user, "web")).namespaces, {
    checkout: 100,
  });
  for (const batch of transactions) {
    assert.ok(batch.length <= 100);
    assert.ok(Buffer.byteLength(JSON.stringify(batch)) <= 3.5 * 1024 * 1024);
  }
  const large = await fixture(0);
  await large.svc.updateProject(manager, "web", {
    ...settings,
    version: 1,
    languages: [...settings.languages, { code: "de", name: "German" }],
  });
  for (let i = 0; i < 10; i++)
    await large.svc.createKey(manager, "web", {
      name: `large.${i}`,
      translations: {
        en: "e".repeat(19000),
        fr: "f".repeat(19000),
        nl: "n".repeat(19000),
        de: "d".repeat(19000),
      },
      description: "x".repeat(1000),
    });
  const largeKeys = await large.svc.keys(user, "web");
  const largePlan = await large.bulk.preview(manager, "web", {
    keys: largeKeys.map(({ name, version }) => ({ name, version })),
    operation: update,
  });
  const first = await large.bulk.apply(manager, "web", largePlan.id, {
    offset: 0,
  });
  assert.ok(first.processed > 0);
  assert.ok(first.processed < 10);
  const last = await large.bulk.apply(manager, "web", largePlan.id, {
    offset: first.processed,
  });
  assert.equal(last.updated, 10);
  assert.equal(last.done, true);
});
