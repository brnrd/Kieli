import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sqliteStore } from "../src/server/store";
import { KeyloService } from "../src/server/service";
import { ProjectHistory } from "../src/server/project-history";
import type { Identity, TranslationKey, ProjectStats } from "../src/shared";
const admin: Identity = {
  sub: "admin",
  name: "Admin",
  email: "admin@example.com",
  admin: true,
  projects: {},
};
const settings = {
  id: "web",
  name: "Web",
  sourceLanguage: "en",
  languages: [
    { code: "en", name: "English" },
    { code: "fr", name: "French" },
  ],
};
async function fixture() {
  const store = await sqliteStore(":memory:"),
    svc = new KeyloService(store);
  await svc.createProject(admin, settings);
  return { svc, store };
}
test("browser writes and import previews reject argument loss before any mutation", async () => {
  const { svc } = await fixture();
  await assert.rejects(
    svc.createKey(admin, "web", {
      name: "bad",
      translations: { en: "Hello {name}", fr: "Bonjour" },
    }),
    /bad \(fr\).*Missing/,
  );
  assert.equal((await svc.keys(admin, "web")).length, 0);
  const key = await svc.createKey(admin, "web", {
    name: "hello",
    translations: { en: "Hello {name}", fr: "Bonjour {name}" },
  });
  await assert.rejects(
    svc.updateKey(admin, "web", key.name, {
      version: key.version,
      translations: { fr: "Bonjour" },
    }),
    /Placeholder mismatch/,
  );
  await assert.rejects(
    svc.previewUpdate(admin, "web", {
      policy: "overwrite",
      keys: [{ name: key.name, translations: { fr: "Bonjour" } }],
    }),
    /Placeholder mismatch/,
  );
  assert.equal((await svc.key(admin, "web", key.name)).version, key.version);
  await assert.rejects(
    svc.previewUpdate(admin, "web", {
      keys: [{ name: "source", translations: { en: "Hello {name" } }],
    }),
    /unsupported placeholder/,
  );
});
test("new-project imports validate the entire batch atomically", async () => {
  const { svc } = await fixture();
  const importId = randomUUID();
  await svc.startImport(admin, {
    project: { ...settings, id: "imported", name: "Imported web" },
    importId,
  });
  await assert.rejects(
    svc.importBatch(admin, "imported", {
      importId,
      keys: [
        { name: "valid", translations: { en: "Valid", fr: "Valide" } },
        { name: "bad", translations: { en: "%s", fr: "%d" } },
      ],
    }),
    /Placeholder mismatch/,
  );
  assert.equal((await svc.keys(admin, "imported")).length, 0);
});
test("source changes preserve old targets, while explicit acceptance validates them", async () => {
  const { svc } = await fixture();
  let key = await svc.createKey(admin, "web", {
    name: "hello",
    translations: { en: "Hello", fr: "Bonjour" },
  });
  key = await svc.updateKey(admin, "web", key.name, {
    version: key.version,
    translations: { en: "Hello {name}" },
  });
  assert.deepEqual(key.outdatedLanguages, ["fr"]);
  await assert.rejects(
    svc.updateKey(admin, "web", key.name, {
      version: key.version,
      translations: { fr: "Bonjour" },
    }),
    /Placeholder mismatch/,
  );
  // Metadata-only edits do not validate or silently certify old target text.
  key = await svc.updateKey(admin, "web", key.name, {
    version: key.version,
    translations: {},
    tags: ["home"],
  });
  assert.deepEqual(key.outdatedLanguages, ["fr"]);
  await assert.rejects(
    svc.export(admin, "web", ["fr"], "flat", true, true),
    /current, complete/,
  );
  await svc.export(admin, "web", ["fr"], "flat", false);
  await svc.updateKey(admin, "web", key.name, {
    version: key.version,
    translations: { fr: "Bonjour {name}" },
  });
  await svc.export(admin, "web", ["fr"], "flat", false, true);
});
test("partial plural drafts remain editable and strict export refuses source fallback", async () => {
  const { svc } = await fixture();
  let key = await svc.createKey(admin, "web", {
    name: "items",
    plural: true,
    translations: {
      en: "{count, plural, one {# item} other {# items}}",
      fr: "{count, plural, one {} other {}}",
    },
  });
  await assert.rejects(
    svc.export(admin, "web", ["fr"], "flat", true, true),
    /current, complete/,
  );
  await assert.rejects(
    svc.updateKey(admin, "web", key.name, {
      version: key.version,
      translations: {
        fr: "{count, plural, one {Un objet} many {Des objets} other {Des objets}}",
      },
    }),
    /Placeholder mismatch/,
  );
  key = await svc.updateKey(admin, "web", key.name, {
    version: key.version,
    translations: {
      fr: "{count, plural, one {# objet} many {# objets} other {# objets}}",
    },
  });
  await svc.export(admin, "web", ["fr"], "flat", false, true);
});
test("linked arguments are checked after resolution and legacy invalid copy cannot publish", async () => {
  const { svc, store } = await fixture();
  await svc.createKey(admin, "web", {
    name: "brand",
    translations: { en: "Brand {name}", fr: "Marque {name}" },
  });
  await svc.createKey(admin, "web", {
    name: "welcome",
    translations: {
      en: "Welcome [%key:brand%]",
      fr: "Bienvenue Marque {name}",
    },
  });
  await assert.rejects(
    svc.createKey(admin, "web", {
      name: "bad",
      translations: { en: "Welcome [%key:brand%]", fr: "Bienvenue" },
    }),
    /Placeholder mismatch/,
  );
  // Simulate a legacy database written before shared quality enforcement.
  const key = await store.get<TranslationKey>("PROJECT#web", "KEY#brand");
  await store.transact([
    {
      pk: "PROJECT#web",
      sk: "KEY#brand",
      value: {
        ...key,
        version: key!.version + 1,
        translations: { en: "Brand {name}", fr: "Marque" },
      },
      expectedVersion: key!.version,
    },
  ]);
  const stats = await store.get<ProjectStats>("PROJECT#web", "STATS");
  await store.transact([
    {
      pk: "PROJECT#web",
      sk: "STATS",
      value: { ...stats, version: stats!.version + 1 },
      expectedVersion: stats!.version,
    },
  ]);
  await assert.rejects(
    svc.export(admin, "web", ["fr"], "flat", false, true),
    /Placeholder mismatch/,
  );
  await assert.rejects(
    new ProjectHistory(store).publish(admin, "web", {
      label: "Invalid",
      channel: "production",
      expectedHeadVersion: 0,
    }),
    /Placeholder mismatch/,
  );
});

test("historical recovery preserves old arguments as outdated rather than certifying them", async () => {
  const { svc } = await fixture();
  let key = await svc.createKey(admin, "web", {
    name: "hello",
    translations: { en: "Hello {name}", fr: "Bonjour {name}" },
  });
  const event = (await svc.keyHistory(admin, "web", key.name, { limit: 1 }))
    .items[0]!;
  key = await svc.updateKey(admin, "web", key.name, {
    version: key.version,
    translations: { en: "Hello {first}", fr: "Bonjour {first}" },
  });
  key = await svc.restoreTranslation(admin, "web", key.name, event.id, {
    version: key.version,
    language: "fr",
    side: "after",
    expectedSourceContext: key.sourceContext,
  });
  assert.equal(key.translations.fr, "Bonjour {name}");
  assert.deepEqual(key.outdatedLanguages, ["fr"]);
  await assert.rejects(
    svc.export(admin, "web", ["fr"], "flat", false, true),
    /current, complete/,
  );
});
