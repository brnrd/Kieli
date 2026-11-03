import test from "node:test";
import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";
import { parseBundle, parseLokalise, parseSnapshot } from "../src/lokalise";
import { KieliService, completedKeys } from "../src/server/service";
import { sqliteStore } from "../src/server/store";
import { HttpError } from "../src/server/auth";
import type { Identity } from "../src/shared";

const admin: Identity = {
  sub: "importer",
  name: "Admin",
  email: "",
  admin: true,
  projects: {},
};
const project = {
  id: "imported",
  name: "Imported",
  sourceLanguage: "en",
  languages: [
    { code: "en", name: "English" },
    { code: "fr", name: "French" },
  ],
};
const importId = "12345678-1234-4123-8123-123456789012";
const key = (name: string) => ({ name, translations: { en: name, fr: "" } });

test("Lokalise ZIP imports nested JSON, canonical locales, empty values, and interpolation", () => {
  const zip = zipSync({
    "locale/en_US.json": strToU8(
      JSON.stringify({ home: { title: "Hello {name}", empty: "" } }),
    ),
    "locale/fr.json": strToU8(
      JSON.stringify({
        home: { title: "Bonjour {name}", subtitle: "Bienvenue" },
      }),
    ),
  });
  const preview = parseLokalise(zip, "Acme.zip");
  assert.equal(preview.keys.length, 3);
  assert.equal(preview.languages[0]?.code, "en-US");
  assert.equal(
    preview.keys.find((k) => k.name === "home.empty")?.translations["en-US"],
    "",
  );
  assert.equal(
    preview.keys.find((k) => k.name === "home.title")?.translations.fr,
    "Bonjour {name}",
  );
  assert.match(preview.warnings.join(" "), /normalized/);
});
test("API snapshots preserve descriptions and tags and explicitly report platform exclusions", () => {
  const preview = parseSnapshot({
    project: { name: "Original project", base_language_iso: "en" },
    languages: [
      { lang_iso: "en", lang_name: "English" },
      { lang_iso: "fr", lang_name: "French" },
    ],
    keys: [
      {
        key_name: { web: "home.title", ios: "homeTitle" },
        description: "Main heading",
        tags: ["hero"],
        translations: [
          { language_iso: "en", translation: "Hello" },
          { language_iso: "fr", translation: "Bonjour" },
        ],
      },
      { key_name: { ios: "native.only" }, translations: [] },
    ],
  });
  assert.equal(preview.name, "Original project");
  assert.equal(preview.keys.length, 1);
  assert.equal(preview.keys[0]?.description, "Main heading");
  assert.deepEqual(preview.keys[0]?.tags, ["hero"]);
  assert.match(preview.warnings.join(" "), /1 keys.*excluded/);
});
test("plural snapshots preserve a single plural key and empty locales", () => {
  const preview = parseSnapshot({
    project: { base_language_iso: "en" },
    languages: [{ lang_iso: "en" }, { lang_iso: "fr" }],
    keys: [
      {
        key_name: "cart.items",
        is_plural: true,
        translations: [
          {
            language_iso: "en",
            translation: { one: "One item", other: "{count} items" },
          },
          { language_iso: "fr", translation: "" },
        ],
      },
    ],
  });
  assert.deepEqual(
    preview.keys.map((k) => k.name),
    ["cart.items"],
  );
  assert.equal(preview.keys[0]?.plural, true);
  assert.match(preview.keys[0]!.translations.en!, /count, plural/);
  assert.equal(preview.keys[0]!.translations.fr, "");
});
test("imports reject unsafe ZIP paths, invalid keys, ambiguous objects, and unsupported values", () => {
  assert.throws(
    () => parseLokalise(zipSync({ "../en.json": strToU8("{}") }), "unsafe.zip"),
    /Unsafe path/,
  );
  assert.throws(
    () => parseBundle([{ name: "en.json", text: '{"hello": ["a"]}' }]),
    /must be a string/,
  );
  assert.throws(
    () => parseBundle([{ name: "en.json", text: '{"a.b":"x","a":{"b":"y"}}' }]),
    /collide/,
  );
  assert.throws(
    () =>
      parseBundle([
        { name: "en.json", text: '{"__proto__":{"polluted":"yes"}}' },
      ]),
    /unsafe key/,
  );
  assert.throws(
    () => parseBundle([{ name: "en.json", text: '{"bad/key":"value"}' }]),
    /Key names/,
  );
  assert.throws(
    () =>
      parseBundle([
        { name: "en_US.json", text: '{"a":"x"}' },
        { name: "en-US.json", text: '{"a":"x"}' },
      ]),
    /More than one file/,
  );
  assert.throws(
    () => parseLokalise(new Uint8Array(10 * 1024 * 1024 + 1), "big.zip"),
    /10 MB/,
  );
});
test("imports create new projects, enforce ownership and roles, and retry batches without overwriting", async () => {
  const svc = new KieliService(await sqliteStore(":memory:"));
  const input = { importId, project };
  const imported = await svc.startImport(admin, input);
  assert.equal((await svc.startImport(admin, input)).id, imported.id);
  await assert.rejects(
    svc.startImport(admin, { ...input, importId: crypto.randomUUID() }),
    (e: unknown) => e instanceof HttpError && e.status === 409,
  );
  const user: Identity = {
    ...admin,
    admin: false,
    projects: { imported: "manager" },
  };
  await assert.rejects(
    svc.startImport(user, input),
    (e: unknown) => e instanceof HttpError && e.status === 403,
  );
  await assert.rejects(
    svc.importBatch({ ...admin, sub: "other-admin" }, "imported", {
      importId,
      keys: [key("a")],
    }),
    (e: unknown) => e instanceof HttpError && e.status === 403,
  );
  assert.deepEqual(
    await svc.importBatch(admin, "imported", {
      importId,
      keys: [key("a"), key("b")],
    }),
    { imported: 2, skipped: 0 },
  );
  assert.deepEqual(
    await svc.importBatch(admin, "imported", {
      importId,
      keys: [key("a"), key("b")],
    }),
    { imported: 0, skipped: 2 },
  );
  await svc.updateKey(admin, "imported", "a", {
    version: 1,
    translations: { fr: "Updated after import" },
  });
  await svc.importBatch(admin, "imported", { importId, keys: [key("a")] });
  assert.equal(
    (await svc.keys(admin, "imported")).find((k) => k.name === "a")
      ?.translations.fr,
    "Updated after import",
  );
  assert.equal((await svc.summary(admin, "imported")).totalKeys, 2);
});
test("a bad import batch is validated entirely before any keys are written", async () => {
  const svc = new KieliService(await sqliteStore(":memory:"));
  await svc.startImport(admin, { importId, project });
  await assert.rejects(
    svc.importBatch(admin, "imported", {
      importId,
      keys: [key("valid"), key("bad/key")],
    }),
  );
  assert.equal((await svc.summary(admin, "imported")).totalKeys, 0);
  assert.deepEqual(await svc.keys(admin, "imported"), []);
});
test("1,100-key projects paginate on the server and search outside the first page", async () => {
  const svc = new KieliService(await sqliteStore(":memory:"));
  await svc.startImport(admin, { importId, project });
  for (let start = 0; start < 1100; start += 20)
    await svc.importBatch(admin, "imported", {
      importId,
      keys: Array.from({ length: 20 }, (_, i) =>
        key(`message.${String(start + i).padStart(4, "0")}`),
      ),
    });
  const first = await svc.keyPage(admin, "imported", { limit: 50 });
  assert.equal(first.items.length, 50);
  assert.equal(first.stats.totalKeys, 1100);
  assert.equal(first.items[0]?.name, "message.0000");
  assert.ok(first.nextCursor);
  const second = await svc.keyPage(admin, "imported", {
    limit: 50,
    cursor: first.nextCursor,
  });
  assert.equal(second.items[0]?.name, "message.0050");
  const found = await svc.keyPage(admin, "imported", {
    limit: 50,
    query: "1099",
  });
  assert.deepEqual(
    found.items.map((k) => k.name),
    ["message.1099"],
  );
  assert.equal(
    (await svc.keyPage(admin, "imported", { limit: 50, status: "complete" }))
      .items.length,
    0,
  );
  const updated = await svc.updateKey(admin, "imported", "message.1099", {
    version: 1,
    translations: { fr: "Traduit" },
  });
  const stats = await svc.summary(admin, "imported");
  assert.equal(stats.byLanguage.fr, 1);
  assert.equal(stats.byLanguage.en, 1100);
  assert.equal(completedKeys(stats, await svc.project(admin, "imported")), 1);
  assert.equal(
    (await svc.keyPage(admin, "imported", { limit: 50, status: "complete" }))
      .items[0]?.name,
    updated.name,
  );
  await svc.updateProject(admin, "imported", {
    ...project,
    version: 1,
    languages: [...project.languages, { code: "nl", name: "Dutch" }],
  });
  assert.equal(
    completedKeys(
      await svc.summary(admin, "imported"),
      await svc.project(admin, "imported"),
    ),
    0,
  );
  await svc.deleteKey(admin, "imported", updated.name, updated.version);
  assert.equal((await svc.summary(admin, "imported")).totalKeys, 1099);
});
test("project names that match JavaScript prototype properties cannot grant implicit access", async () => {
  const svc = new KieliService(await sqliteStore(":memory:"));
  await svc.createProject(admin, { ...project, id: "constructor" });
  await assert.rejects(
    svc.keys({ ...admin, admin: false, projects: {} }, "constructor"),
    (e: unknown) => e instanceof HttpError && e.status === 403,
  );
});
