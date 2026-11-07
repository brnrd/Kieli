import test from "node:test";
import assert from "node:assert/strict";
import { sqliteStore, Conflict } from "../src/server/store";
import { KieliService } from "../src/server/service";
import type { Identity } from "../src/shared";
const admin: Identity = {
  sub: "admin",
  name: "Admin",
  email: "a@example.test",
  admin: true,
  projects: {},
};
async function fixture() {
  const store = await sqliteStore(":memory:"),
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
    description: "Context",
    tags: ["tag"],
    namespace: "home",
    translations: { en: "Hello", fr: "Bonjour" },
  });
  return { svc, store, key };
}
test("duplicate has independent identity/history and optional context/targets", async () => {
  const { svc, key } = await fixture();
  const copy = await svc.duplicateKey(admin, "web", "hello", {
    name: "copy",
    version: key.version,
  });
  assert.notEqual(copy.id, key.id);
  assert.deepEqual(copy.translations, { en: "Hello" });
  assert.equal(copy.namespace, "home");
  const minimal = await svc.duplicateKey(admin, "web", "hello", {
    name: "minimal",
    version: 1,
    copyContext: false,
    copyTargets: true,
  });
  assert.equal(minimal.description, "");
  assert.deepEqual(minimal.tags, []);
  assert.equal(minimal.namespace, "general");
  assert.equal(minimal.translations.fr, "Bonjour");
  assert.equal(
    (await svc.keyHistory(admin, "web", "copy", { limit: 25 })).items.length,
    1,
  );
  assert.equal((await svc.key(admin, "web", "hello")).version, 1);
  await assert.rejects(
    svc.duplicateKey(admin, "web", "hello", { name: "copy", version: 1 }),
    Conflict,
  );
});
test("duplicates preserve outdated status and enabled native plurals without accepting copy", async () => {
  const { svc } = await fixture();
  const old = await svc.updateKey(admin, "web", "hello", {
    version: 1,
    translations: { en: "Hi" },
  });
  const copy = await svc.duplicateKey(admin, "web", "hello", {
    name: "stale",
    version: old.version,
    copyTargets: true,
  });
  assert.deepEqual(copy.outdatedLanguages, ["fr"]);
  await assert.rejects(svc.export(admin, "web", ["fr"], "flat", false, true));
  await svc.setLanguageEnabled(admin, "web", "fr", {
    version: 1,
    enabled: false,
  });
  const active = await svc.duplicateKey(admin, "web", "hello", {
    name: "enabled",
    version: old.version,
    copyTargets: true,
  });
  assert.equal(active.translations.fr, undefined);
});
test("permissions, archive, stale versions and same-name/invalid names reject", async () => {
  const { svc } = await fixture();
  for (const identity of [
    { ...admin, admin: false, projects: { web: "user" as const } },
    { ...admin, tokenProject: "web" },
    { ...admin, sync: {} as Identity["sync"] },
    { ...admin, mcp: {} as Identity["mcp"] },
  ])
    await assert.rejects(
      svc.duplicateKey(identity, "web", "hello", { name: "copy", version: 1 }),
    );
  for (const input of [
    { name: "hello", version: 1 },
    { name: "bad/key", version: 1 },
    { name: "copy", version: 2 },
  ])
    await assert.rejects(svc.duplicateKey(admin, "web", "hello", input));
  await svc.setProjectArchived(admin, "web", { version: 1, archived: true });
  await assert.rejects(
    svc.duplicateKey(admin, "web", "hello", { name: "copy", version: 1 }),
  );
});
test("concurrent source edits fence duplication atomically", async () => {
  let action: (() => Promise<unknown>) | undefined;
  const raw = await sqliteStore(":memory:");
  const store = {
    ...raw,
    async transact(changes: import("../src/server/store").Change[]) {
      if (action && changes.some((c) => c.sk === "KEY#copy")) {
        const run = action;
        action = undefined;
        await run();
      }
      return raw.transact(changes);
    },
  };
  const svc = new KieliService(store);
  await svc.createProject(admin, {
    id: "web",
    name: "Web",
    sourceLanguage: "en",
    languages: [{ code: "en", name: "English" }],
  });
  await svc.createKey(admin, "web", {
    name: "hello",
    translations: { en: "Hello" },
  });
  action = () =>
    svc.updateKey(admin, "web", "hello", {
      version: 1,
      translations: { en: "Changed" },
    });
  await assert.rejects(
    svc.duplicateKey(admin, "web", "hello", { name: "copy", version: 1 }),
    Conflict,
  );
  await assert.rejects(svc.key(admin, "web", "copy"));
});
test("plural metadata and references remain usable on an independent copy", async () => {
  const { svc } = await fixture();
  const plural = await svc.createKey(admin, "web", {
    name: "items",
    plural: true,
    applePluralTypes: { en: "lld" },
    translations: { en: "{n, plural, one {# item} other {# items}}" },
  });
  const copy = await svc.duplicateKey(admin, "web", "items", {
    name: "items.copy",
    version: plural.version,
  });
  assert.equal(copy.plural, true);
  assert.deepEqual(copy.applePluralTypes, { en: "lld" });
  const linked = await svc.createKey(admin, "web", {
    name: "linked",
    translations: { en: "[%key:hello%]" },
  });
  const linkCopy = await svc.duplicateKey(admin, "web", "linked", {
    name: "linked.copy",
    version: linked.version,
  });
  assert.equal(linkCopy.resolvedTranslations?.en, "Hello");
});
