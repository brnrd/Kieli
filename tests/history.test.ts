import test from "node:test";
import assert from "node:assert/strict";
import {
  sqliteStore,
  Conflict,
  type Store,
  type Change,
} from "../src/server/store";
import { KeyloService } from "../src/server/service";
import { ProjectHistory } from "../src/server/project-history";
import { HttpError } from "../src/server/errors";
import { dataPrefix } from "../src/server/project-data";
import type { Identity } from "../src/shared";
const admin: Identity = {
  sub: "admin",
  name: "Admin",
  email: "admin@example.com",
  admin: true,
  projects: {},
};
const user: Identity = {
  ...admin,
  admin: false,
  projects: { website: "user" },
};
const outsider: Identity = { ...user, projects: {} };
const settings = {
  id: "website",
  name: "Website",
  sourceLanguage: "en",
  description: "",
  languages: [
    { code: "en", name: "English" },
    { code: "fr", name: "French" },
  ],
};
const initial = {
  name: "hello",
  namespace: "general",
  translations: { en: "Hello {name}", fr: "Bonjour {name}" },
};
const denied = (status: number) => (error: unknown) =>
  error instanceof HttpError && error.status === status;
async function fixture() {
  const store = await sqliteStore(":memory:");
  const svc = new KeyloService(store);
  await svc.createProject(admin, settings);
  await svc.createKey(admin, "website", initial);
  return { store, svc, history: new ProjectHistory(store) };
}
test("snapshots and OTA administration require project management; unauthorized identities cannot retrieve parts", async () => {
  const { history } = await fixture();
  const snapshot = await history.create(admin, "website", "Before");
  for (const identity of [user, outsider]) {
    await assert.rejects(history.list(identity, "website"), denied(403));
    await assert.rejects(
      history.part(identity, "website", snapshot.id, 0),
      denied(403),
    );
    await assert.rejects(
      history.restore(identity, "website", snapshot.id, 1),
      denied(403),
    );
    await assert.rejects(
      history.createDeliveryKey(identity, "website", "App"),
      denied(403),
    );
    await assert.rejects(history.releases(identity, "website"), denied(403));
  }
});
test("restore atomically swaps complete project data, keeps identity and adds a safety backup", async () => {
  const { store, svc, history } = await fixture();
  const snapshot = await history.create(
    admin,
    "website",
    "Before copy changes",
  );
  const previous = await svc.key(admin, "website", "hello");
  await svc.updateKey(admin, "website", "hello", {
    version: previous.version,
    translations: { en: "New copy", fr: "Nouvelle copie" },
  });
  await svc.createKey(admin, "website", { ...initial, name: "later" });
  const project = await svc.project(admin, "website");
  await svc.updateProject(admin, "website", {
    ...settings,
    version: project.version,
    languages: [...settings.languages, { code: "de", name: "German" }],
  });
  const current = await svc.project(admin, "website");
  const restored = await history.restore(
    admin,
    "website",
    snapshot.id,
    current.version,
  );
  assert.deepEqual(
    (await svc.keys(admin, "website")).map((key) => key.name),
    ["hello"],
  );
  assert.equal(
    (await svc.key(admin, "website", "hello")).translations.en,
    initial.translations.en,
  );
  assert.equal((await svc.project(admin, "website")).languages.length, 2);
  assert.equal(
    (await history.download(admin, "website", restored.safetySnapshot)).keys
      .length,
    2,
  );
  assert.equal((await svc.summary(admin, "website")).totalKeys, 1);
  assert.ok(
    await store.get(
      "PROJECT#website",
      `${dataPrefix(restored.project)}KEY#hello`,
    ),
  );
  await assert.rejects(
    svc.updateKey(admin, "website", "hello", {
      version: previous.version,
      translations: { fr: "Stale edit" },
    }),
    (error) => error instanceof Conflict,
  );
  const second = await history.restore(
    admin,
    "website",
    restored.safetySnapshot,
    restored.project.version,
  );
  assert.equal((await svc.keys(admin, "website")).length, 2);
  assert.ok(
    (await svc.key(admin, "website", "hello")).version >
      (await store.get<{ version: number }>(
        "PROJECT#website",
        `${dataPrefix(restored.project)}KEY#hello`,
      ))!.version,
  );
  assert.notEqual(second.project.dataRevision, restored.project.dataRevision);
});
test("corrupt snapshot parts fail integrity validation before any restoration", async () => {
  const { store, svc, history } = await fixture();
  const snapshot = await history.create(admin, "website", "Before");
  const sk = `SNAPDATA#${snapshot.id}#00000`;
  const part = await store.get<{ version: number; keys: unknown[] }>(
    "PROJECT#website",
    sk,
  );
  await store.put("PROJECT#website", sk, { ...part!, keys: [] }, 1);
  await assert.rejects(
    history.restore(admin, "website", snapshot.id, 1),
    /integrity/,
  );
  assert.equal((await svc.keys(admin, "website")).length, 1);
});
test("a failed staging transaction leaves the active dataset unchanged", async () => {
  const { store, svc, history } = await fixture();
  const snapshot = await history.create(admin, "website", "Before");
  const old = await svc.key(admin, "website", "hello");
  await svc.updateKey(admin, "website", "hello", {
    version: old.version,
    translations: { en: "Keep current" },
  });
  const wrapped: Store = {
    ...store,
    async transact(changes: Change[]) {
      if (
        changes.some(
          (change) =>
            change.sk.startsWith("REV#") && change.sk.includes("KEY#"),
        )
      )
        throw new Error("Simulated storage failure");
      return store.transact(changes);
    },
  };
  await assert.rejects(
    new ProjectHistory(wrapped).restore(admin, "website", snapshot.id, 1),
    /storage failure/,
  );
  assert.equal(
    (await svc.key(admin, "website", "hello")).translations.en,
    "Keep current",
  );
  assert.equal((await svc.project(admin, "website")).dataRevision, undefined);
});
test("project guard blocks edits racing a snapshot restore", async () => {
  const { store, svc, history } = await fixture();
  const snapshot = await history.create(admin, "website", "Before");
  const old = await svc.key(admin, "website", "hello");
  let fired = false;
  const wrapped: Store = {
    ...store,
    async transact(changes: Change[]) {
      if (
        !fired &&
        changes.some((change) => change.sk === "KEY#hello" && change.value)
      ) {
        fired = true;
        await history.restore(admin, "website", snapshot.id, 1);
      }
      return store.transact(changes);
    },
  };
  await assert.rejects(
    new KeyloService(wrapped).updateKey(admin, "website", "hello", {
      version: old.version,
      translations: { fr: "Concurrent" },
    }),
    (error) => error instanceof Conflict,
  );
  assert.equal(
    (await svc.key(admin, "website", "hello")).translations.fr,
    initial.translations.fr,
  );
});
test("releases stay immutable, channels roll back, delivery keys authenticate before conditional responses", async () => {
  const { svc, history } = await fixture();
  const credential = await history.createDeliveryKey(admin, "website", "iOS");
  const release = await history.publish(admin, "website", {
    label: "First",
    channel: "production",
    expectedHeadVersion: 0,
  });
  let response = await history.deliver(
    "website",
    "fr",
    "production",
    credential.secret,
    null,
  );
  const etag = response.headers.get("etag")!;
  assert.equal(response.status, 200);
  assert.equal(
    (await response.json()).messages.hello.value,
    initial.translations.fr,
  );
  const before = await svc.key(admin, "website", "hello");
  await svc.updateKey(admin, "website", "hello", {
    version: before.version,
    translations: { fr: "Changed" },
  });
  response = await history.deliver(
    "website",
    "fr",
    "production",
    credential.secret,
    etag,
  );
  assert.equal(response.status, 304);
  const second = await history.publish(admin, "website", {
    label: "Second",
    channel: "production",
    expectedHeadVersion: 1,
  });
  assert.notEqual(second.id, release.id);
  response = await history.deliver(
    "website",
    "fr",
    "production",
    credential.secret,
    null,
  );
  assert.equal((await response.json()).messages.hello.value, "Changed");
  await history.pointRelease(admin, "website", {
    release: release.id,
    channel: "production",
    expectedHeadVersion: 2,
  });
  assert.equal(
    (
      await history.deliver(
        "website",
        "fr",
        "production",
        credential.secret,
        etag,
      )
    ).status,
    304,
  );
  await assert.rejects(
    history.deliver("website", "fr", "production", "export-token", etag),
    denied(401),
  );
  await history.revokeDeliveryKey(admin, "website", credential.id);
  await assert.rejects(
    history.deliver("website", "fr", "production", credential.secret, etag),
    denied(401),
  );
});
test("incomplete drafts, unsupported formatting and channel races never replace a working release", async () => {
  const { svc, history } = await fixture();
  await history.publish(admin, "website", {
    label: "First",
    channel: "production",
    expectedHeadVersion: 0,
  });
  await assert.rejects(
    history.publish(admin, "website", {
      label: "Stale publish",
      channel: "production",
      expectedHeadVersion: 0,
    }),
    (error) => error instanceof Conflict,
  );
  let key = await svc.key(admin, "website", "hello");
  await svc.updateKey(admin, "website", "hello", {
    version: key.version,
    translations: { fr: "" },
  });
  await assert.rejects(
    history.publish(admin, "website", {
      label: "Incomplete",
      channel: "production",
      expectedHeadVersion: 1,
    }),
    denied(422),
  );
  key = await svc.key(admin, "website", "hello");
  await svc.updateKey(admin, "website", "hello", {
    version: key.version,
    translations: { fr: "{date,date,long}" },
  });
  await assert.rejects(
    history.publish(admin, "website", {
      label: "Formatter",
      channel: "production",
      expectedHeadVersion: 1,
    }),
    denied(422),
  );
  assert.equal((await history.releases(admin, "website")).releases.length, 1);
});
test("missing published bundle data fails closed so clients can keep their cache", async () => {
  const { store, history } = await fixture();
  const credential = await history.createDeliveryKey(admin, "website", "App");
  const release = await history.publish(admin, "website", {
    label: "First",
    channel: "production",
    expectedHeadVersion: 0,
  });
  await store.remove("PROJECT#website", `OTADATA#${release.id}#fr#00000`, 1);
  await assert.rejects(
    history.deliver("website", "fr", "production", credential.secret, null),
    denied(503),
  );
});
test("automatic snapshots honor scheduling and retention; stale revisions are collected without deleting active data", async () => {
  const { store, svc, history } = await fixture();
  await svc.updateProject(admin, "website", {
    ...settings,
    version: 1,
    snapshotPolicy: { enabled: true, intervalHours: 24, retention: 2 },
  });
  assert.equal((await history.maintenance(admin))[0]!.status, "created");
  assert.deepEqual(await history.maintenance(admin), []);
  const snapshots = await history.list(admin, "website");
  assert.equal(snapshots.length, 1);
  for (let i = 0; i < 3; i++) {
    const item = await history.create(
      admin,
      "website",
      `Old ${i}`,
      "automatic",
    );
    const full = await store.get<Record<string, unknown> & { version: number }>(
      "PROJECT#website",
      `SNAP#${item.id}`,
    );
    await store.put(
      "PROJECT#website",
      `SNAP#${item.id}`,
      {
        ...full!,
        createdAt: new Date(Date.now() - (i + 2) * 86400000).toISOString(),
        version: 3,
      },
      2,
    );
  }
  await history.maintenance(admin);
  assert.equal((await history.list(admin, "website")).length, 2);
  const snapshot = (await history.list(admin, "website"))[0]!;
  const restored = await history.restore(admin, "website", snapshot.id, 2);
  const cleanup = await store.get<
    Record<string, unknown> & { version: number }
  >("PROJECT#website", "CLEANUP#legacy");
  await store.put(
    "PROJECT#website",
    "CLEANUP#legacy",
    { ...cleanup!, createdAt: "2020-01-01T00:00:00.000Z", version: 2 },
    1,
  );
  await history.maintenance(admin);
  assert.equal(await store.get("PROJECT#website", "KEY#hello"), undefined);
  assert.ok(
    await store.get(
      "PROJECT#website",
      `${dataPrefix(restored.project)}KEY#hello`,
    ),
  );
});
test("resolved references affect completion, edits and exports; deletion of referenced keys is blocked", async () => {
  const { svc } = await fixture();
  await svc.createKey(admin, "website", {
    name: "linked",
    namespace: "general",
    translations: { en: "[%key:hello%]", fr: "[%key:hello%]" },
  });
  let exported = await svc.export(admin, "website", ["fr"], "flat", false);
  assert.equal(
    (exported.translations.fr as Record<string, string>).linked,
    "Bonjour {name}",
  );
  const hello = await svc.key(admin, "website", "hello");
  await svc.updateKey(admin, "website", "hello", {
    version: hello.version,
    translations: { fr: "" },
  });
  const page = await svc.keyPage(admin, "website", {
    limit: 20,
    status: "missing",
    languages: ["fr"],
  });
  assert.equal(page.items.length, 2);
  await assert.rejects(
    svc.export(admin, "website", ["fr"], "flat", false),
    /Missing referenced/,
  );
  await assert.rejects(
    svc.deleteKey(admin, "website", "hello", hello.version + 1),
    /does not exist/,
  );
});

test("snapshot integrity survives reordered DynamoDB map attributes", async () => {
  const { store, history } = await fixture();
  const snapshot = await history.create(admin, "website", "Before");
  const sk = `SNAPDATA#${snapshot.id}#00000`;
  const part = await store.get<{
    version: number;
    keys: Record<string, unknown>[];
  }>("PROJECT#website", sk);
  const keys = part!.keys.map((key) =>
    Object.fromEntries(Object.entries(key).reverse()),
  );
  await store.put("PROJECT#website", sk, { ...part!, keys }, 1);
  assert.equal(
    (await history.download(admin, "website", snapshot.id)).keys.length,
    1,
  );
});

test("plural completion follows project settings and MCP fills forms without changing populated copy or variables", async () => {
  const { svc } = await fixture();
  await svc.createKey(admin, "website", {
    name: "items",
    plural: true,
    translations: {
      en: "{count, plural, one {One} other {# items}}",
      fr: "{count, plural, one {Un} other {}}",
    },
  });
  let page = await svc.keyPage(admin, "website", {
    limit: 20,
    status: "missing",
    languages: ["fr"],
  });
  assert.equal(page.items.find((key) => key.name === "items")?.plural, true);
  const identity: Identity = {
    ...user,
    mcp: {
      projectId: "website",
      credentialId: "fixture",
      languages: ["fr"],
      allowOverwrite: false,
    },
  };
  let key = await svc.key(admin, "website", "items");
  await assert.rejects(
    svc.setMcpTranslations(identity, "website", {
      updates: [
        {
          key: "items",
          expectedVersion: key.version,
          translations: {
            fr: "{n, plural, one {Un} many {Beaucoup} other {# objets}}",
          },
        },
      ],
    }),
    denied(403),
  );
  await svc.setMcpTranslations(identity, "website", {
    updates: [
      {
        key: "items",
        expectedVersion: key.version,
        translations: {
          fr: "{count, plural, one {Un} many {Beaucoup} other {# objets}}",
        },
      },
    ],
  });
  key = await svc.key(admin, "website", "items");
  await assert.rejects(
    svc.setMcpTranslations(identity, "website", {
      updates: [
        {
          key: "items",
          expectedVersion: key.version,
          translations: {
            fr: "{count, plural, one {Changed} many {Beaucoup} other {# objets}}",
          },
        },
      ],
    }),
    denied(409),
  );
  await assert.rejects(
    svc.updateKey(user, "website", "items", {
      version: key.version,
      translations: { fr: "{n, plural, other {Different variable}}" },
    }),
    denied(403),
  );
  page = await svc.keyPage(admin, "website", {
    limit: 20,
    status: "complete",
    languages: ["fr"],
  });
  assert.ok(page.items.some((key) => key.name === "items"));
});

test("advanced projects paginate thousands of keys and reuse a revision-bounded view", async () => {
  const { store, svc } = await fixture();
  const { indexed, emptyStats, count } = await import("../src/server/service");
  const { batches } = await import("../src/server/project-history");
  const stats = emptyStats();
  const writes: Change[] = [];
  const date = new Date().toISOString();
  for (let i = 0; i < 1500; i++) {
    const key = indexed({
      name: `item.${String(i).padStart(4, "0")}`,
      namespace: "item",
      description: "",
      tags: [],
      plural: true,
      translations: {
        en: "{count, plural, one {One item} other {# items}}",
        fr: "",
      },
      version: 1,
      createdAt: date,
      updatedAt: date,
      updatedBy: "fixture",
    });
    count(stats, key, 1);
    writes.push({ pk: "PROJECT#website", sk: `KEY#${key.name}`, value: key });
  }
  const original = await svc.key(admin, "website", "hello");
  count(stats, original, 1);
  await batches(store, writes);
  const old = await store.get<{ version: number }>("PROJECT#website", "STATS");
  stats.version = old!.version + 1;
  await store.put("PROJECT#website", "STATS", stats as never, old!.version);
  let reads = 0;
  const measured: Store = {
    ...store,
    async list<T>(pk: string, prefix: string) {
      if (prefix.endsWith("KEY#")) reads++;
      return store.list<T>(pk, prefix);
    },
  };
  const paged = new KeyloService(measured);
  const first = await paged.keyPage(admin, "website", { limit: 100 });
  assert.equal(first.items.length, 100);
  assert.ok(first.nextCursor);
  const second = await paged.keyPage(admin, "website", {
    limit: 100,
    cursor: first.nextCursor,
  });
  assert.equal(second.items.length, 100);
  assert.notEqual(first.items[0]!.name, second.items[0]!.name);
  assert.equal(reads, 1);
  assert.equal((await paged.summary(admin, "website")).totalKeys, 1501);
  assert.equal(reads, 1);
});
