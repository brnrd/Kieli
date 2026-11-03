import test from "node:test";
import assert from "node:assert/strict";
import {
  sqliteStore,
  Conflict,
  type Store,
  type Change,
} from "../src/server/store";
import { KieliService } from "../src/server/service";
import { ProjectHistory } from "../src/server/project-history";
import { Glossary } from "../src/server/glossary";
import { KeyRenames } from "../src/server/key-renames";
import { SyncCredentials } from "../src/server/sync-credentials";
import { HttpError } from "../src/server/errors";
import type { Identity } from "../src/shared";
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
  description: "Synthetic project",
  sourceLanguage: "en",
  languages: [
    { code: "en", name: "English" },
    { code: "fr", name: "French" },
  ],
};
const denied = (status: number) => (e: unknown) =>
  e instanceof HttpError && e.status === status;
async function fixture(wrap: (store: Store) => Store = (store) => store) {
  const store = wrap(await sqliteStore(":memory:")),
    svc = new KieliService(store);
  const project = await svc.createProject(admin, settings);
  const key = await svc.createKey(admin, "web", {
    name: "hello",
    translations: { en: "Hello", fr: "Bonjour" },
  });
  return {
    store,
    svc,
    project,
    key,
    history: new ProjectHistory(store),
    glossary: new Glossary(store),
  };
}
test("archive and restore retain data, settings, identity and history; metadata and audit are versioned", async () => {
  const { store, svc, project, key } = await fixture();
  const before = await store.list("PROJECT#web", "");
  const archived = await svc.setProjectArchived(manager, "web", {
    version: project.version,
    archived: true,
  });
  assert.ok(archived.archivedAt);
  assert.equal(archived.archivedBy, manager.name);
  assert.equal(archived.version, 2);
  assert.deepEqual(await store.list("PROJECT#web", ""), before);
  assert.equal((await svc.key(user, "web", "hello")).id, key.id);
  assert.equal(
    (await svc.bootstrap(user)).projects[0]!.archivedAt,
    archived.archivedAt,
  );
  assert.equal(
    (await svc.keyHistory(user, "web", "hello", { limit: 25 })).items.length,
    1,
  );
  await assert.rejects(svc.createProject(admin, settings), denied(409));
  await assert.rejects(
    svc.setProjectArchived(manager, "web", { version: 1, archived: false }),
    Conflict,
  );
  const restored = await svc.setProjectArchived(manager, "web", {
    version: archived.version,
    archived: false,
  });
  assert.equal(restored.archivedAt, undefined);
  assert.equal(restored.archivedBy, undefined);
  assert.equal(restored.version, 3);
  assert.equal(restored.description, project.description);
  assert.deepEqual(restored.languages, project.languages);
  await svc.updateKey(user, "web", "hello", {
    version: key.version,
    translations: { fr: "Salut" },
  });
  const audits = await store.list<{ action: string }>("AUTH_AUDIT", "");
  assert.ok(audits.some((event) => event.action === "project.archived"));
  assert.ok(audits.some((event) => event.action === "project.unarchived"));
});
test("only signed-in managers can change archive state; generic settings cannot forge it", async () => {
  const { svc } = await fixture();
  for (const identity of [
    user,
    { ...user, projects: {} },
    { ...admin, tokenProject: "web" },
    { ...admin, mcp: {} as Identity["mcp"] },
    { ...admin, sync: {} as Identity["sync"] },
  ])
    await assert.rejects(
      svc.setProjectArchived(identity, "web", { version: 1, archived: true }),
      denied(403),
    );
  await assert.rejects(
    svc.updateProject(admin, "web", {
      ...settings,
      version: 1,
      archivedAt: new Date().toISOString(),
    }),
  );
  await assert.rejects(
    svc.setProjectArchived(admin, "web", {
      version: 1,
      archived: true,
      name: "Changed",
    }),
  );
  assert.equal((await svc.project(admin, "web")).version, 1);
});
test("archiving blocks key writes, imports, renames, glossary changes, history and snapshot restores", async () => {
  const { svc, key, project, history, glossary, store } = await fixture();
  const term = await glossary.save(admin, "web", {
    source: "Hello",
    translations: { fr: "Bonjour" },
    notes: "",
    caseSensitive: false,
  });
  const snapshot = await history.create(admin, "web", "Before archive");
  const plan = await svc.previewUpdate(admin, "web", {
    keys: [{ name: "hello", translations: { en: "Changed" } }],
  });
  const event = (await svc.keyHistory(admin, "web", "hello", { limit: 25 }))
    .items[0]!;
  const archived = await svc.setProjectArchived(manager, "web", {
    version: project.version,
    archived: true,
  });
  const before = await store.list("PROJECT#web", "");
  const actions = [
    () =>
      svc.createKey(admin, "web", { name: "new", translations: { en: "New" } }),
    () =>
      svc.updateKey(user, "web", "hello", {
        version: key.version,
        translations: { fr: "Salut" },
      }),
    () => svc.deleteKey(admin, "web", "hello", key.version),
    () =>
      svc.updateProject(manager, "web", {
        ...settings,
        name: "Renamed",
        version: archived.version,
      }),
    () =>
      new KeyRenames(store, svc).run(manager, "web", "hello", {
        name: "greeting",
        version: key.version,
      }),
    () =>
      svc.previewUpdate(admin, "web", {
        keys: [{ name: "new", translations: { en: "New" } }],
      }),
    () => svc.applyUpdate(admin, "web", plan.id),
    () =>
      glossary.save(admin, "web", {
        source: "Other",
        translations: {},
        notes: "",
        caseSensitive: false,
      }),
    () => glossary.remove(admin, "web", term.id, term.version),
    () =>
      svc.restoreTranslation(admin, "web", "hello", event.id, {
        version: key.version,
        language: "fr",
        side: "after",
      }),
    () => history.restore(admin, "web", snapshot.id, archived.version),
    () =>
      history.publish(admin, "web", {
        label: "Blocked",
        channel: "production",
        expectedHeadVersion: 0,
      }),
  ];
  for (const action of actions) await assert.rejects(action, denied(409));
  assert.deepEqual(await store.list("PROJECT#web", ""), before);
});
test("existing exports, published delivery, backup creation and credential revocation work while archived", async () => {
  const { svc, history, project, key } = await fixture();
  const exported = await svc.export(user, "web", ["en", "fr"], "flat", false);
  await svc.createToken(manager, "web", { name: "CI" });
  const delivery = await history.createDeliveryKey(manager, "web", "App");
  const release = await history.publish(manager, "web", {
    label: "Live",
    channel: "production",
    expectedHeadVersion: 0,
  });
  const bundle = await history.deliver(
    "web",
    "fr",
    "production",
    delivery.secret,
    null,
  );
  await svc.setProjectArchived(manager, "web", {
    version: project.version,
    archived: true,
  });
  assert.deepEqual(
    await svc.export(
      { ...user, tokenProject: "web" },
      "web",
      ["en", "fr"],
      "flat",
      false,
    ),
    exported,
  );
  assert.deepEqual(
    await history.deliver("web", "fr", "production", delivery.secret, null),
    bundle,
  );
  assert.equal(
    (await history.create(manager, "web", "Archived backup")).status,
    "ready",
  );
  await assert.rejects(
    history.pointRelease(manager, "web", {
      release: release.id,
      channel: "preview",
      expectedHeadVersion: 0,
    }),
    denied(409),
  );
  const tokens = await svc.tokens(manager, "web");
  await svc.revokeToken(manager, "web", tokens[0]!.id);
  await history.revokeDeliveryKey(manager, "web", delivery.id);
  assert.equal((await svc.key(user, "web", "hello")).version, key.version);
});
test("archive fences a concurrent key save and glossary mutation; restoration does not revive stale import previews", async () => {
  let intercept: (() => Promise<void>) | undefined;
  const { svc, key, glossary } = await fixture((store) => ({
    ...store,
    async transact(changes: Change[]) {
      if (
        intercept &&
        changes.some(
          (change) =>
            change.sk.startsWith("KEY_HISTORY#") ||
            change.sk === "GLOSSARY_META",
        )
      ) {
        const action = intercept;
        intercept = undefined;
        await action();
      }
      return store.transact(changes);
    },
  }));
  const plan = await svc.previewUpdate(admin, "web", {
    keys: [{ name: "new", translations: { en: "New" } }],
  });
  intercept = async () => {
    await svc.setProjectArchived(manager, "web", {
      version: 1,
      archived: true,
    });
  };
  await assert.rejects(
    svc.updateKey(user, "web", "hello", {
      version: key.version,
      translations: { fr: "Changed" },
    }),
    (error) => error instanceof Conflict || denied(409)(error),
  );
  assert.equal(
    (await svc.key(user, "web", "hello")).translations.fr,
    "Bonjour",
  );
  await svc.setProjectArchived(manager, "web", { version: 2, archived: false });
  await assert.rejects(svc.applyUpdate(admin, "web", plan.id), Conflict);
  intercept = async () => {
    await svc.setProjectArchived(manager, "web", {
      version: 3,
      archived: true,
    });
  };
  await assert.rejects(
    glossary.save(admin, "web", {
      source: "Hello",
      translations: {},
      notes: "",
      caseSensitive: false,
    }),
    denied(409),
  );
  assert.equal((await glossary.list(user, "web", {})).items.length, 0);
});
test("source-sync and MCP writes cannot bypass archived state", async () => {
  const { svc, project, key, store } = await fixture();
  const sync = await new SyncCredentials(store).create(manager, "web", {
    name: "CI",
  });
  const syncIdentity = await new SyncCredentials(store).authenticate(
    new Request("http://localhost/sync", {
      headers: { authorization: `Bearer ${sync.secret}` },
    }),
  );
  await svc.setProjectArchived(manager, "web", {
    version: project.version,
    archived: true,
  });
  await assert.rejects(
    svc.previewUpdate(syncIdentity, "web", {
      policy: "source",
      keys: [{ name: "hello", translations: { en: "New" } }],
    }),
    denied(409),
  );
  const mcp: Identity = {
    ...user,
    mcp: {
      projectId: "web",
      credentialId: "test",
      languages: ["fr"],
      allowOverwrite: true,
    },
  };
  await assert.rejects(
    svc.setMcpTranslations(mcp, "web", {
      overwriteExisting: true,
      updates: [
        {
          key: "hello",
          expectedVersion: key.version,
          expectedSourceContext: key.sourceContext,
          translations: { fr: "Salut" },
        },
      ],
    }),
    denied(409),
  );
});
test("archiving during rename or OTA publication prevents their visible commit", async () => {
  for (const operation of ["rename", "publish"] as const) {
    let intercept: (() => Promise<void>) | undefined;
    const { svc, key, store, history } = await fixture((base) => ({
      ...base,
      async transact(changes: Change[]) {
        if (
          intercept &&
          changes.some(
            (change) =>
              change.value?.action ===
              (operation === "rename"
                ? "key.renamed"
                : "ota.release_published"),
          )
        ) {
          const action = intercept;
          intercept = undefined;
          await action();
        }
        return base.transact(changes);
      },
    }));
    const renames = new KeyRenames(store, svc);
    const plan = await renames.run(manager, "web", "hello", {
      name: "greeting",
      version: key.version,
    });
    const { references, affectedKeys, ...input } = plan as {
      name: string;
      version: number;
      projectVersion: number;
      statsVersion: number;
      references: unknown;
      affectedKeys: number;
    };
    intercept = async () => {
      await svc.setProjectArchived(manager, "web", {
        version: 1,
        archived: true,
      });
    };
    await assert.rejects(
      operation === "rename"
        ? renames.run(manager, "web", "hello", input, true)
        : history.publish(manager, "web", {
            label: "Racing",
            channel: "production",
            expectedHeadVersion: 0,
          }),
      Conflict,
    );
    assert.equal((await svc.key(user, "web", "hello")).id, key.id);
    assert.equal((await store.list("PROJECT#web", "OTAHEAD#")).length, 0);
    assert.equal((await store.list("PROJECT#web", "OTARELEASE#")).length, 0);
    assert.equal(
      (await svc.keyHistory(user, "web", "hello", { limit: 25 })).items.length,
      1,
    );
  }
});
test("concurrent archive requests produce a single state change and audit event", async () => {
  const { svc, store } = await fixture();
  const results = await Promise.allSettled(
    [manager, admin].map((identity) =>
      svc.setProjectArchived(identity, "web", { version: 1, archived: true }),
    ),
  );
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal((await svc.project(admin, "web")).version, 2);
  assert.equal(
    (await store.list<{ action: string }>("AUTH_AUDIT", "")).filter(
      (item) => item.action === "project.archived",
    ).length,
    1,
  );
});
