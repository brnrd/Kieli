import test from "node:test";
import assert from "node:assert/strict";
import {
  sqliteStore,
  Conflict,
  type Store,
  type Change,
} from "../src/server/store";
import { KieliService, completedKeys } from "../src/server/service";
import { ProjectHistory } from "../src/server/project-history";
import { McpCredentials } from "../src/server/mcp-credentials";
import { workspaceOverview } from "../src/server/workspace";
import { HttpError } from "../src/server/errors";
import type { Identity, ProjectStats } from "../src/shared";
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
  projects: { web: "manager" },
};
const user: Identity = { ...manager, projects: { web: "user" } };
const settings = {
  id: "web",
  name: "Web",
  sourceLanguage: "en",
  languages: [
    { code: "en", name: "English" },
    {
      code: "fr",
      name: "French",
      pluralForms: ["one", "other"] as ("one" | "other")[],
    },
    { code: "nl", name: "Dutch" },
  ],
};
const denied = (status: number) => (error: unknown) =>
  error instanceof HttpError && error.status === status;
async function fixture(wrap: (store: Store) => Store = (store) => store) {
  const store = wrap(await sqliteStore(":memory:")),
    svc = new KieliService(store);
  await svc.createProject(admin, settings);
  const key = await svc.createKey(admin, "web", {
    name: "hello",
    translations: { en: "Hello", fr: "Bonjour", nl: "Hallo" },
    applePluralTypes: { fr: "lld" },
  });
  return { store, svc, key, history: new ProjectHistory(store) };
}
test("language lifecycle preserves all copy, native metadata, history and freshness; state changes are audited", async () => {
  const { svc, store, key } = await fixture();
  const before = await store.list("PROJECT#web", "");
  const disabled = await svc.setLanguageEnabled(manager, "web", "fr", {
    version: 1,
    enabled: false,
  });
  assert.equal(disabled.languages[1]!.disabled, true);
  assert.deepEqual(await store.list("PROJECT#web", ""), before);
  assert.deepEqual(await svc.key(user, "web", "hello"), key);
  assert.equal(
    (
      await svc.setLanguageEnabled(manager, "web", "fr", {
        version: 2,
        enabled: false,
      })
    ).version,
    2,
  );
  const changed = await svc.updateKey(manager, "web", "hello", {
    version: key.version,
    translations: { en: "Hi" },
  });
  assert.ok(changed.outdatedLanguages?.includes("fr"));
  const enabled = await svc.setLanguageEnabled(manager, "web", "fr", {
    version: 2,
    enabled: true,
  });
  assert.deepEqual(enabled.languages, settings.languages);
  assert.equal(
    (await svc.key(user, "web", "hello")).translations.fr,
    "Bonjour",
  );
  assert.deepEqual((await svc.key(user, "web", "hello")).applePluralTypes, {
    fr: "lld",
  });
  assert.ok(
    (await svc.key(user, "web", "hello")).outdatedLanguages?.includes("fr"),
  );
  const audits = await store.list<{ action: string }>("AUTH_AUDIT", "");
  assert.deepEqual(audits.map((row) => row.action).sort(), [
    "language.disabled",
    "language.enabled",
  ]);
});
test("language controls enforce managers, signed-in scope, source immutability, archive state and stale settings", async () => {
  const { svc } = await fixture();
  for (const identity of [
    user,
    { ...manager, projects: {} },
    { ...admin, tokenProject: "web" },
    { ...admin, mcp: {} as Identity["mcp"] },
    { ...admin, sync: {} as Identity["sync"] },
  ])
    await assert.rejects(
      svc.setLanguageEnabled(identity, "web", "fr", {
        version: 1,
        enabled: false,
      }),
      denied(403),
    );
  await assert.rejects(
    svc.setLanguageEnabled(admin, "web", "en", { version: 1, enabled: false }),
    denied(400),
  );
  await assert.rejects(
    svc.setLanguageEnabled(admin, "web", "de", { version: 1, enabled: false }),
    denied(400),
  );
  await assert.rejects(
    svc.updateProject(admin, "web", {
      ...settings,
      version: 1,
      languages: settings.languages.map((l) => ({ ...l, disabled: true })),
    }),
  );
  await svc.setLanguageEnabled(manager, "web", "fr", {
    version: 1,
    enabled: false,
  });
  await assert.rejects(
    svc.updateProject(manager, "web", { ...settings, version: 1 }),
    Conflict,
  );
  await svc.setProjectArchived(manager, "web", { version: 2, archived: true });
  await assert.rejects(
    svc.setLanguageEnabled(manager, "web", "fr", { version: 3, enabled: true }),
    denied(409),
  );
});
test("disabled targets reject all explicit copy writes, import previews, native metadata and history restoration", async () => {
  const { svc, key } = await fixture();
  const event = (await svc.keyHistory(manager, "web", "hello", { limit: 25 }))
    .items[0]!;
  const plan = await svc.previewUpdate(manager, "web", {
    keys: [{ name: "hello", translations: { fr: "Salut" } }],
    policy: "overwrite",
  });
  await svc.setLanguageEnabled(manager, "web", "fr", {
    version: 1,
    enabled: false,
  });
  for (const action of [
    () =>
      svc.updateKey(user, "web", "hello", {
        version: key.version,
        translations: { fr: "Salut" },
      }),
    () =>
      svc.updateKey(manager, "web", "hello", {
        version: key.version,
        translations: {},
        applePluralTypes: { fr: "d" },
      }),
    () =>
      svc.updateKey(manager, "web", "hello", {
        version: key.version,
        translations: {},
        applePluralTypes: {},
      }),
    () =>
      svc.createKey(manager, "web", {
        name: "metadata",
        translations: { en: "Other" },
        applePluralTypes: { fr: "ld" },
      }),
    () =>
      svc.createKey(manager, "web", {
        name: "other",
        translations: { en: "Other", fr: "Autre" },
      }),
    () =>
      svc.previewUpdate(manager, "web", {
        keys: [{ name: "hello", translations: { fr: "Salut" } }],
      }),
    () =>
      svc.restoreTranslation(user, "web", "hello", event.id, {
        version: key.version,
        language: "fr",
        side: "after",
      }),
  ])
    await assert.rejects(action(), denied(409));
  await assert.rejects(svc.applyUpdate(manager, "web", plan.id), Conflict);
  await svc.updateKey(user, "web", "hello", {
    version: key.version,
    translations: { nl: "Hoi" },
  });
  assert.equal(
    (await svc.key(user, "web", "hello")).translations.fr,
    "Bonjour",
  );
});
test("default exports, editor filters and completion ignore disabled targets; explicit strict exports retain their checks", async () => {
  const { svc, key } = await fixture();
  await svc.updateKey(user, "web", "hello", {
    version: key.version,
    translations: { fr: "" },
  });
  const project = await svc.setLanguageEnabled(manager, "web", "fr", {
    version: 1,
    enabled: false,
  });
  assert.equal(completedKeys(await svc.summary(user, "web"), project), 1);
  assert.equal(
    (await svc.keyPage(user, "web", { limit: 10, status: "complete" })).items
      .length,
    1,
  );
  assert.equal(
    (await svc.keyPage(user, "web", { limit: 10, status: "incomplete" })).items
      .length,
    0,
  );
  await assert.rejects(
    svc.keyPage(user, "web", { limit: 10, languages: ["fr"] }),
    denied(409),
  );
  const exported = await svc.export(user, "web", [], "flat", false, true);
  assert.deepEqual(Object.keys(exported.translations), ["en", "nl"]);
  assert.deepEqual(
    Object.keys(
      (await svc.export(user, "web", ["fr"], "flat", false)).translations,
    ),
    ["fr"],
  );
  await assert.rejects(
    svc.export(user, "web", ["fr"], "flat", false, true),
    denied(422),
  );
});
test("outdated key totals count overlapping enabled locales exactly, with no key scan or rewrite on toggles", async () => {
  const { svc, store, key } = await fixture();
  await svc.updateKey(manager, "web", "hello", {
    version: key.version,
    translations: { en: "Hi" },
  });
  await svc.createKey(manager, "web", {
    name: "second",
    translations: { en: "Bye", fr: "Au revoir" },
  });
  await svc.updateKey(manager, "web", "second", {
    version: 1,
    translations: { en: "Goodbye" },
  });
  assert.equal((await svc.summary(user, "web")).outdatedKeys, 2);
  await svc.setLanguageEnabled(manager, "web", "fr", {
    version: 1,
    enabled: false,
  });
  assert.equal((await svc.summary(user, "web")).outdatedKeys, 1);
  const overview = await workspaceOverview(admin, store);
  assert.equal(overview.totals.outdated, 1);
  assert.equal(overview.totals.targetSlots, 2);
  await svc.setLanguageEnabled(manager, "web", "nl", {
    version: 2,
    enabled: false,
  });
  assert.equal((await svc.summary(user, "web")).outdatedKeys, 0);
  assert.equal((await workspaceOverview(admin, store)).totals.targetSlots, 0);
  await svc.setLanguageEnabled(manager, "web", "fr", {
    version: 3,
    enabled: true,
  });
  assert.equal((await svc.summary(user, "web")).outdatedKeys, 2);
});
test("disabling a target fences concurrent key saves and settings changes", async () => {
  let intercept: (() => Promise<void>) | undefined;
  const { svc, key } = await fixture((store) => ({
    ...store,
    async transact(changes: Change[]) {
      if (
        intercept &&
        changes.some((change) => change.sk.startsWith("KEY_HISTORY#"))
      ) {
        const action = intercept;
        intercept = undefined;
        await action();
      }
      return store.transact(changes);
    },
  }));
  intercept = () =>
    svc
      .setLanguageEnabled(manager, "web", "fr", { version: 1, enabled: false })
      .then(() => {});
  await assert.rejects(
    svc.updateKey(user, "web", "hello", {
      version: key.version,
      translations: { fr: "Salut" },
    }),
    Conflict,
  );
  assert.equal(
    (await svc.key(user, "web", "hello")).translations.fr,
    "Bonjour",
  );
  const results = await Promise.allSettled([
    svc.setLanguageEnabled(manager, "web", "fr", { version: 2, enabled: true }),
    svc.setLanguageEnabled(manager, "web", "nl", {
      version: 2,
      enabled: false,
    }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    results.filter(
      (r) => r.status === "rejected" && r.reason instanceof Conflict,
    ).length,
    1,
  );
});
test("MCP cannot create grants or write disabled targets; an existing grant resumes after enabling", async () => {
  process.env.AUTH_MODE = "demo";
  const { svc, store, key } = await fixture();
  const credentials = new McpCredentials(store);
  const token = await credentials.create(manager, "web", {
    name: "Claude",
    languages: ["fr"],
    allowOverwrite: true,
  });
  const identity = await credentials.authenticate(
    new Request("http://localhost/mcp", {
      headers: { authorization: `Bearer ${token.secret}` },
    }),
  );
  await svc.setLanguageEnabled(manager, "web", "fr", {
    version: 1,
    enabled: false,
  });
  await assert.rejects(
    credentials.create(manager, "web", { name: "Other", languages: ["fr"] }),
    denied(400),
  );
  const update = {
    updates: [
      {
        key: "hello",
        expectedVersion: key.version,
        expectedSourceContext: key.sourceContext,
        translations: { fr: "Salut" },
      },
    ],
    overwriteExisting: true,
  };
  await assert.rejects(
    svc.setMcpTranslations(identity, "web", update),
    denied(409),
  );
  await svc.setLanguageEnabled(manager, "web", "fr", {
    version: 2,
    enabled: true,
  });
  await svc.setMcpTranslations(identity, "web", update);
  assert.equal((await svc.key(user, "web", "hello")).translations.fr, "Salut");
});
test("snapshots retain disabled copy and settings; new mobile releases exclude disabled targets", async () => {
  const { svc, history } = await fixture();
  const delivery = await history.createDeliveryKey(manager, "web", "App");
  await history.publish(manager, "web", {
    label: "All",
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
  await svc.setLanguageEnabled(manager, "web", "fr", {
    version: 1,
    enabled: false,
  });
  assert.deepEqual(
    await history.deliver("web", "fr", "production", delivery.secret, null),
    bundle,
  );
  const snapshot = await history.create(manager, "web", "Paused");
  const release = await history.publish(manager, "web", {
    label: "Active",
    channel: "preview",
    expectedHeadVersion: 0,
  });
  assert.deepEqual(release.languages, ["en", "nl"]);
  await svc.setLanguageEnabled(manager, "web", "fr", {
    version: 2,
    enabled: true,
  });
  await history.restore(manager, "web", snapshot.id, 3);
  assert.equal(
    (await svc.project(manager, "web")).languages[1]!.disabled,
    true,
  );
  assert.equal(
    (await svc.key(user, "web", "hello")).translations.fr,
    "Bonjour",
  );
});
test("older counters rebuild the outdated histogram without altering translation records", async () => {
  const { svc, store, key } = await fixture();
  await svc.updateKey(manager, "web", "hello", {
    version: key.version,
    translations: { en: "Hi" },
  });
  const stats = (await store.get<ProjectStats>("PROJECT#web", "STATS"))!;
  await store.put(
    "PROJECT#web",
    "STATS",
    {
      ...stats,
      messageVersion: 2,
      outdatedCoverage: undefined,
      version: stats.version + 1,
    },
    stats.version,
  );
  const before = await svc.keys(user, "web");
  await svc.setLanguageEnabled(manager, "web", "fr", {
    version: 1,
    enabled: false,
  });
  assert.equal((await svc.summary(user, "web")).outdatedKeys, 1);
  assert.deepEqual(await svc.keys(user, "web"), before);
});

test("plural and linked key summaries respect disabled locales while preserving explicit native exports", async () => {
  const { svc } = await fixture();
  const plural = await svc.createKey(manager, "web", {
    name: "items",
    plural: true,
    translations: {
      en: "{count, plural, one {# item} other {# items}}",
      fr: "{count, plural, one {# article} other {# articles}}",
      nl: "{count, plural, one {# ding} other {# dingen}}",
    },
    applePluralTypes: { en: "ld", fr: "lld", nl: "d" },
  });
  await svc.createKey(manager, "web", {
    name: "linked",
    translations: {
      en: "[%key:hello%]",
      fr: "[%key:hello%]",
      nl: "[%key:hello%]",
    },
  });
  await svc.updateKey(manager, "web", plural.name, {
    version: plural.version,
    translations: { en: "{count, plural, one {# product} other {# products}}" },
  });
  await svc.setLanguageEnabled(manager, "web", "fr", {
    version: 1,
    enabled: false,
  });
  await svc.setLanguageEnabled(manager, "web", "nl", {
    version: 2,
    enabled: false,
  });
  assert.equal((await svc.summary(user, "web")).outdatedKeys, 0);
  assert.equal(
    (await svc.keyPage(user, "web", { limit: 10, status: "complete" })).items
      .length,
    3,
  );
  const native = await svc.export(user, "web", ["fr"], "stringsdict", false);
  assert.ok(native.files?.[0]?.content.includes("lld"));
  assert.equal(
    (await svc.key(user, "web", "items")).applePluralTypes?.fr,
    "lld",
  );
  await svc.setLanguageEnabled(manager, "web", "fr", {
    version: 3,
    enabled: true,
  });
  assert.equal((await svc.summary(user, "web")).outdatedKeys, 1);
  assert.equal(
    (await svc.keyPage(user, "web", { limit: 10, status: "outdated" })).items[0]
      ?.name,
    "items",
  );
});
