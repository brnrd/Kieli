import test from "node:test";
import assert from "node:assert/strict";
import { sqliteStore, Conflict, type Store } from "../src/server/store";
import { KeyloService } from "../src/server/service";
import { TranslationMemory } from "../src/server/translation-memory";
import { ProjectHistory } from "../src/server/project-history";
import { HttpError } from "../src/server/errors";
import type { Identity } from "../src/shared";
import type { KeyEdit } from "../src/server/key-history";
const admin: Identity = {
  sub: "admin",
  name: "Alex",
  email: "alex@example.com",
  admin: true,
  projects: {},
};
const user: Identity = { ...admin, admin: false, projects: { web: "user" } };
const lookup = { source: "Hello {name}", language: "fr" };
async function fixture() {
  const store = await sqliteStore(":memory:"),
    svc = new KeyloService(store),
    memory = new TranslationMemory(store);
  await svc.createProject(admin, {
    id: "web",
    name: "Web",
    sourceLanguage: "en",
    languages: [
      { code: "en", name: "English" },
      { code: "fr", name: "French" },
      { code: "nl", name: "Dutch" },
    ],
  });
  const key = await svc.createKey(admin, "web", {
    name: "hello",
    translations: {
      en: lookup.source,
      fr: "Bonjour {name}",
      nl: "Hallo {name}",
    },
  });
  return { store, svc, memory, key };
}
const forbidden = (error: unknown) =>
  error instanceof HttpError && error.status === 403;
test("exact source suggestions retain provenance, project roles and target language boundaries", async () => {
  const f = await fixture();
  let page = await f.memory.lookup(user, "web", lookup);
  assert.equal(page.items[0]?.text, "Bonjour {name}");
  assert.equal(page.items[0]?.keyName, "hello");
  assert.equal(page.items[0]?.keyVersion, 1);
  assert.equal(page.items[0]?.savedBy, "Alex");
  assert.equal(page.items[0]?.origin, "browser");
  assert.ok(page.items[0]?.savedAt);
  assert.equal(JSON.stringify(page).includes("Hallo"), false);
  for (const source of [
    "hello {name}",
    "Hello {name} ",
    "Hello {other}",
    "Hello {name}\n",
  ])
    assert.equal(
      (await f.memory.lookup(user, "web", { ...lookup, source })).items.length,
      0,
    );
  await assert.rejects(
    f.memory.lookup({ ...user, projects: {} }, "web", lookup),
    forbidden,
  );
  await assert.rejects(
    f.memory.lookup(user, "web", { ...lookup, language: "en" }),
  );
  await assert.rejects(
    f.memory.lookup(user, "web", { ...lookup, language: "de" }),
  );
  for (const scope of [
    { tokenProject: "web" },
    { sync: { projectId: "web", credentialId: "c", prefixes: [] } },
    {
      mcp: {
        projectId: "web",
        credentialId: "c",
        languages: ["fr"],
        allowOverwrite: false,
      },
    },
  ]) {
    await assert.rejects(
      f.memory.lookup({ ...admin, ...scope }, "web", lookup),
      forbidden,
    );
    await assert.rejects(
      f.memory.indexBatch({ ...admin, ...scope }, "web"),
      forbidden,
    );
  }
  await assert.rejects(f.memory.indexBatch(user, "web"), forbidden);
  await f.svc.createProject(admin, {
    id: "other",
    name: "Other",
    sourceLanguage: "en",
    languages: [
      { code: "en", name: "English" },
      { code: "fr", name: "French" },
    ],
  });
  assert.equal((await f.memory.lookup(admin, "other", lookup)).items.length, 0);
});
test("source changes retain old valid wording while outdated and invalid historical targets are excluded", async () => {
  const f = await fixture();
  const changed = await f.svc.updateKey(admin, "web", "hello", {
    version: f.key.version,
    translations: { en: "Welcome {name}" },
  });
  assert.equal(
    (
      await f.memory.lookup(user, "web", {
        ...lookup,
        source: "Welcome {name}",
      })
    ).items.length,
    0,
  );
  assert.equal(
    (await f.memory.lookup(user, "web", lookup)).items[0]?.text,
    "Bonjour {name}",
  );
  await f.svc.updateKey(user, "web", "hello", {
    version: changed.version,
    translations: { fr: "Bienvenue {name}" },
  });
  assert.equal(
    (
      await f.memory.lookup(user, "web", {
        ...lookup,
        source: "Welcome {name}",
      })
    ).items[0]?.text,
    "Bienvenue {name}",
  );
  // Stored legacy history can contain copy predating placeholder validation.
  const entries = await f.store.list<KeyEdit>("PROJECT#web", "KEY_HISTORY#");
  for (const event of entries) {
    if (event.before) event.before.translations.fr = "Broken {different}";
    if (event.after) event.after.translations.fr = "Broken {different}";
    await f.store.put(
      "PROJECT#web",
      `KEY_HISTORY#${event.keyId}#${event.id}`,
      { ...event, version: event.version + 1 },
      event.version,
    );
  }
  assert.equal((await f.memory.lookup(user, "web", lookup)).items.length, 0);
});
test("deleted keys and reused names never reveal the previous key's retained history", async () => {
  const f = await fixture();
  await f.svc.deleteKey(admin, "web", "hello", f.key.version);
  assert.equal((await f.memory.lookup(user, "web", lookup)).items.length, 0);
  const replacement = await f.svc.createKey(admin, "web", {
    name: "hello",
    translations: { en: lookup.source, fr: "Salut {name}" },
  });
  assert.notEqual(replacement.id, f.key.id);
  const values = (await f.memory.lookup(user, "web", lookup)).items.map(
    (item) => item.text,
  );
  assert.deepEqual(values, ["Salut {name}"]);
});
test("reuse saves through normal version, source-context and placeholder validation without changing source or other targets", async () => {
  const f = await fixture();
  const target = await f.svc.createKey(admin, "web", {
    name: "another",
    translations: { en: lookup.source },
  });
  const suggestion = (await f.memory.lookup(user, "web", lookup)).items.find(
    (item) => item.keyName === "hello",
  )!;
  const saved = await f.svc.updateKey(user, "web", "another", {
    version: target.version,
    expectedSourceContext: target.sourceContext,
    translations: { fr: suggestion.text },
  });
  assert.equal(saved.translations.en, lookup.source);
  assert.equal(saved.translations.fr, "Bonjour {name}");
  assert.equal(saved.translations.nl, undefined);
  await assert.rejects(
    f.svc.updateKey(user, "web", "another", {
      version: target.version,
      translations: { fr: suggestion.text },
    }),
    Conflict,
  );
  const history = await f.svc.keyHistory(user, "web", "another", { limit: 10 });
  assert.equal(history.items[0]?.after?.translations.fr, suggestion.text);
  await assert.rejects(
    f.svc.updateKey(user, "web", "another", {
      version: saved.version,
      translations: { fr: "Wrong {person}" },
    }),
  );
});
test("history pointers commit atomically, and a concurrent edit has exactly one winner", async () => {
  const f = await fixture();
  const before = await f.store.list("PROJECT#web", "TM#");
  const failing: Store = {
    ...f.store,
    transact: async () => {
      throw new Conflict();
    },
  };
  await assert.rejects(
    new KeyloService(failing).updateKey(user, "web", "hello", {
      version: f.key.version,
      translations: { fr: "Never saved {name}" },
    }),
    Conflict,
  );
  assert.equal(
    (await f.store.list("PROJECT#web", "TM#")).length,
    before.length,
  );
  const results = await Promise.allSettled(
    ["Salut {name}", "Coucou {name}"].map((fr) =>
      f.svc.updateKey(user, "web", "hello", {
        version: f.key.version,
        translations: { fr },
      }),
    ),
  );
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const history = await f.store.list<KeyEdit>("PROJECT#web", "KEY_HISTORY#");
  const ids = new Set(history.map((event) => event.id));
  for (const pointer of await f.store.list<{ eventId: string }>(
    "PROJECT#web",
    "TM#",
  ))
    assert.ok(ids.has(pointer.eventId));
});
test("older history indexing is bounded, resumable, idempotent and safe under competing builders", async () => {
  const f = await fixture();
  for (let i = 0; i < 32; i++)
    await f.svc.createKey(admin, "web", {
      name: `old.${i}`,
      translations: { en: lookup.source, fr: `Ancien ${i} {name}` },
    });
  const pointers = await f.store.page<{ version: number }>(
    "PROJECT#web",
    "TM#",
    { limit: 100 },
  );
  // Test-only reconstruction of a pre-index database; immutable history remains intact.
  for (const pointer of await f.store.list<{
    version: number;
    eventId: string;
    side: string;
    keyId: string;
  }>("PROJECT#web", "TM#")) {
    const events = await f.store.list<KeyEdit>(
      "PROJECT#web",
      `KEY_HISTORY#${pointer.keyId}#`,
    );
    const event = events.find((event) => event.id === pointer.eventId)!;
    const { memoryChanges } = await import("../src/server/translation-memory");
    const project = await f.svc.project(admin, "web");
    const entry = memoryChanges(project, event).find(
      (change) => change.value?.side === pointer.side,
    )!;
    await f.store.remove(entry.pk, entry.sk, pointer.version);
  }
  assert.equal((await f.memory.lookup(user, "web", lookup)).items.length, 0);
  const competing = await Promise.allSettled(
    [1, 2].map(() => f.memory.indexBatch(admin, "web")),
  );
  assert.ok(competing.some((result) => result.status === "fulfilled"));
  let status = await f.memory.indexBatch(admin, "web");
  while (!status.done) status = await f.memory.indexBatch(admin, "web");
  assert.equal(status.scanned, 33);
  assert.deepEqual(await f.memory.indexBatch(admin, "web"), status);
  assert.ok((await f.memory.lookup(user, "web", lookup)).items.length);
  assert.equal(
    (await f.store.list("PROJECT#web", "TM#")).length,
    pointers.items.length,
  );
});

test("plural matches require the same source structure and complete locale forms; linked copy is excluded", async () => {
  const f = await fixture();
  const en = "{count, plural, one {# item} other {# items}}";
  const fr =
    "{count, plural, one {# article} many {# articles} other {# articles}}";
  await f.svc.createKey(admin, "web", {
    name: "items",
    plural: true,
    translations: { en, fr },
  });
  assert.equal(
    (
      await f.memory.lookup(user, "web", {
        source: en,
        plural: true,
        language: "fr",
      })
    ).items[0]?.text,
    fr,
  );
  assert.equal(
    (
      await f.memory.lookup(user, "web", {
        source: en,
        plural: false,
        language: "fr",
      })
    ).items.length,
    0,
  );
  await f.svc.createKey(admin, "web", {
    name: "linked",
    translations: { en: "[%key:hello%]", fr: "[%key:hello%]" },
  });
  assert.equal(
    (await f.memory.lookup(user, "web", { ...lookup, source: "[%key:hello%]" }))
      .items.length,
    0,
  );
});
test("pagination is bounded and cursors cannot cross projects, sources or target languages", async () => {
  const f = await fixture();
  for (let i = 0; i < 24; i++)
    await f.svc.createKey(admin, "web", {
      name: `same.${i}`,
      translations: { en: lookup.source, fr: `Variante ${i} {name}` },
    });
  let page = await f.memory.lookup(user, "web", lookup);
  assert.ok(page.nextCursor);
  assert.ok(page.items.length <= 20);
  const cursor = page.nextCursor!;
  for (const changes of [{ source: "Different" }, { language: "nl" }])
    await assert.rejects(
      f.memory.lookup(user, "web", { ...lookup, ...changes, cursor }),
    );
  await f.svc.createProject(admin, {
    id: "elsewhere",
    name: "Elsewhere",
    sourceLanguage: "en",
    languages: [
      { code: "en", name: "English" },
      { code: "fr", name: "French" },
    ],
  });
  await assert.rejects(
    f.memory.lookup(admin, "elsewhere", { ...lookup, cursor }),
  );
  const values = page.items.map((item) => item.text);
  while (page.nextCursor) {
    page = await f.memory.lookup(user, "web", {
      ...lookup,
      cursor: page.nextCursor,
    });
    values.push(...page.items.map((item) => item.text));
  }
  assert.equal(new Set(values).size, 25);
  // A removed history record must not be reconstructed from its index pointer.
  const history = await f.store.list<KeyEdit>("PROJECT#web", "KEY_HISTORY#");
  for (const event of history)
    await f.store.remove(
      "PROJECT#web",
      `KEY_HISTORY#${event.keyId}#${event.id}`,
      event.version,
    );
  assert.equal((await f.memory.lookup(user, "web", lookup)).items.length, 0);
});
test("snapshot restore filters suggestions against the active dataset and preserves eligible history for restored identities", async () => {
  const f = await fixture(),
    history = new ProjectHistory(f.store);
  const snapshot = await history.create(admin, "web", "Before extra keys");
  await f.svc.createKey(admin, "web", {
    name: "later",
    translations: { en: lookup.source, fr: "Later-only {name}" },
  });
  const project = await f.svc.project(admin, "web");
  await history.restore(admin, "web", snapshot.id, project.version);
  const values = (await f.memory.lookup(user, "web", lookup)).items.map(
    (item) => item.text,
  );
  assert.ok(values.includes("Bonjour {name}"));
  assert.equal(values.includes("Later-only {name}"), false);
  assert.ok((await f.svc.project(admin, "web")).dataRevision);
});
test("twenty-key imports stay within the transaction ceiling and populate matching history atomically", async () => {
  const f = await fixture();
  const importId = crypto.randomUUID();
  await f.svc.startImport(admin, {
    importId,
    project: {
      id: "imported",
      name: "Imported",
      sourceLanguage: "en",
      languages: [
        { code: "en", name: "English" },
        { code: "fr", name: "French" },
      ],
    },
  });
  const batch = await f.svc.importBatch(admin, "imported", {
    importId,
    keys: Array.from({ length: 20 }, (_, i) => ({
      name: `import.${i}`,
      translations: { en: lookup.source, fr: `Import ${i} {name}` },
    })),
  });
  assert.equal(batch.imported, 20);
  assert.equal(
    (await f.memory.lookup(admin, "imported", lookup)).items.length,
    20,
  );
});
