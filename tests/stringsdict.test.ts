import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DOMParser } from "@xmldom/xmldom";
import { zipSync, strToU8 } from "fflate";
import { parseStringsDict, writeStringsDict } from "../src/formats/stringsdict";
import { parseTranslationFiles } from "../src/formats/import";
import { parseCatalog } from "../src/formats/parse";
import { exportFiles, writeCatalog } from "../src/formats/write";
import { KieliService } from "../src/server/service";
import { ProjectHistory } from "../src/server/project-history";
import { sqliteStore, Conflict } from "../src/server/store";
import { readPlural } from "../src/messages";
import type { Identity } from "../src/shared";
const english = await readFile(
  new URL("./fixtures/stringsdict/en.stringsdict", import.meta.url),
  "utf8",
);
const russian = await readFile(
  new URL("./fixtures/stringsdict/ru.stringsdict", import.meta.url),
  "utf8",
);
// Independent plist decoder: compare native keys, types and exact strings rather
// than relying on an importer/exporter pair that could share the same mistake.
function native(xml: string): unknown {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  function value(node: Element): unknown {
    if (node.tagName === "string" || node.tagName === "key")
      return node.textContent;
    const elements = Array.from(node.childNodes).filter(
      (child): child is Element => child.nodeType === 1,
    );
    if (node.tagName === "plist") return value(elements[0]!);
    assert.equal(node.tagName, "dict");
    return Object.fromEntries(
      Array.from({ length: elements.length / 2 }, (_, index) => [
        elements[index * 2]!.textContent,
        value(elements[index * 2 + 1]!),
      ]),
    );
  }
  return value(doc.documentElement);
}
const admin: Identity = {
  sub: "admin",
  name: "Alex",
  email: "alex@example.com",
  admin: true,
  projects: {},
};
const user: Identity = { ...admin, admin: false, projects: { apple: "user" } };
async function fixture() {
  const store = await sqliteStore(":memory:"),
    service = new KieliService(store);
  const preview = parseTranslationFiles(
    zipSync({
      "en.lproj/Localizable.stringsdict": strToU8(english),
      "en.lproj/Localizable.strings": strToU8('"greeting" = "Hello";'),
      "ru.lproj/Localizable.stringsdict": strToU8(russian),
    }),
    "apple.zip",
  );
  await service.createProject(admin, {
    id: "apple",
    name: "Apple",
    sourceLanguage: "en",
    languages: preview.languages,
  });
  for (const key of preview.keys) await service.createKey(admin, "apple", key);
  return { store, service, preview };
}
for (const [lang, text] of [
  ["en", english],
  ["ru", russian],
])
  test(`Apple ${lang} native dictionary golden round-trip preserves variable names, integer types and exact form strings`, () => {
    const parsed = parseStringsDict(text!);
    const output = writeStringsDict(parsed.catalog, parsed.types);
    assert.deepEqual(native(output), native(text!));
    assert.deepEqual(parseCatalog(text!, "stringsdict", lang!), parsed.catalog);
    assert.deepEqual(parseStringsDict(output).types, parsed.types);
  });
test("import merges disjoint .strings companions and stores per-locale integer types without flattening forms", async () => {
  const { preview, service } = await fixture();
  assert.equal(preview.keys.length, 4);
  const items = await service.key(user, "apple", "cart.items");
  assert.equal(items.plural, true);
  assert.deepEqual(items.applePluralTypes, { en: "ld", ru: "ld" });
  assert.equal(readPlural(items.translations.en!)?.variable, "itemCount");
  assert.equal(
    readPlural(items.translations.ru!)?.forms.few,
    "# товара в корзине",
  );
  const exported = await service.export(
    user,
    "apple",
    ["en"],
    "stringsdict",
    false,
  );
  assert.deepEqual(
    exported.files.map((file) => file.name),
    ["en.stringsdict", "en.strings"],
  );
  assert.deepEqual(native(exported.files[0]!.content), native(english));
  assert.equal(
    parseCatalog(exported.files[1]!.content, "strings", "en").get("greeting"),
    "Hello",
  );
  const again = parseTranslationFiles(
    zipSync(
      Object.fromEntries(
        exported.files.map((file) => [file.name, strToU8(file.content)]),
      ),
    ),
    "again.zip",
  );
  assert.deepEqual(
    again.keys.find((key) => key.name === "cart.items")?.applePluralTypes,
    { en: "ld" },
  );
});
test("native metadata survives edits, history, trash and snapshots; users cannot change types", async () => {
  const { service, store } = await fixture(),
    history = new ProjectHistory(store);
  const key = await service.key(admin, "apple", "cart.items");
  const saved = await service.updateKey(user, "apple", key.name, {
    version: key.version,
    translations: {
      ru: "{itemCount, plural, one {# товар} few {# товара} many {# товаров} other {# товара}}",
    },
  });
  assert.deepEqual(saved.applePluralTypes, key.applePluralTypes);
  await assert.rejects(
    service.updateKey(user, "apple", key.name, {
      version: saved.version,
      translations: {},
      applePluralTypes: { en: "d" },
    }),
  );
  const snapshot = await history.create(admin, "apple", "Native backup");
  const changed = await service.updateKey(admin, "apple", key.name, {
    version: saved.version,
    translations: {},
    applePluralTypes: { en: "lld", ru: "lld" },
  });
  const events = await service.keyHistory(admin, "apple", key.name, {
    limit: 10,
  });
  assert.equal(events.items[0]?.before?.applePluralTypes?.en, "ld");
  assert.equal(events.items[0]?.after?.applePluralTypes?.en, "lld");
  await assert.rejects(
    service.updateKey(admin, "apple", key.name, {
      version: saved.version,
      translations: {},
      applePluralTypes: { en: "d" },
    }),
    Conflict,
  );
  await service.deleteKey(admin, "apple", key.name, changed.version);
  const trash = await service.deletedKeys(admin, "apple", { limit: 10 });
  await service.restoreDeletedKey(admin, "apple", trash.items[0]!.id, {
    version: trash.items[0]!.version,
  });
  assert.equal(
    (await service.key(admin, "apple", key.name)).applePluralTypes?.en,
    "lld",
  );
  const project = await service.project(admin, "apple");
  await history.restore(admin, "apple", snapshot.id, project.version);
  assert.equal(
    (await service.key(admin, "apple", key.name)).applePluralTypes?.en,
    "ld",
  );
  const downloaded = await history.download(admin, "apple", snapshot.id);
  assert.equal(
    downloaded.keys.find((key) => key.name === "cart.items")?.applePluralTypes
      ?.ru,
    "ld",
  );
});
test("project update previews preserve populated target metadata unless overwrite is selected", async () => {
  const { service } = await fixture(),
    key = await service.key(admin, "apple", "cart.items");
  const input = { ...key, applePluralTypes: { en: "lld", ru: "lld" } };
  const data = {
    name: key.name,
    translations: key.translations,
    plural: true,
    applePluralTypes: input.applePluralTypes,
  };
  const merge = await service.previewUpdate(admin, "apple", {
    policy: "merge",
    keys: [data],
  });
  await service.applyUpdate(admin, "apple", merge.id);
  assert.deepEqual(
    (await service.key(admin, "apple", key.name)).applePluralTypes,
    { en: "lld", ru: "ld" },
  );
  const overwrite = await service.previewUpdate(admin, "apple", {
    policy: "overwrite",
    keys: [data],
  });
  await service.applyUpdate(admin, "apple", overwrite.id);
  assert.deepEqual(
    (await service.key(admin, "apple", key.name)).applePluralTypes,
    { en: "lld", ru: "lld" },
  );
  await assert.rejects(
    service.createKey(admin, "apple", {
      name: "bad",
      translations: { en: "Hello" },
      applePluralTypes: { fr: "ld" },
    }),
  );
});
test("missing native targets stay empty and new ICU counts default to d with source-type inheritance", () => {
  const en = "{count, plural, one {# item} other {# items}}";
  const files = exportFiles(
    { fr: { items: "", hello: "" } },
    "stringsdict",
    "en",
    new Map([["items", en]]),
    [{ name: "items", plural: true, applePluralTypes: { en: "lld" } } as never],
  );
  const parsed = parseStringsDict(files[0]!.content);
  assert.equal(parsed.types.get("items"), "lld");
  assert.deepEqual(readPlural(parsed.catalog.get("items")!)?.forms, {
    other: "",
  });
  const defaulted = writeStringsDict(new Map([["items", en]]));
  assert.equal(parseStringsDict(defaulted).types.get("items"), "d");
  assert.equal(
    parseCatalog(files[1]!.content, "strings", "fr").get("hello"),
    "",
  );
});
for (const [label, change] of [
  [
    "unsupported type",
    (xml: string) => xml.replace("<string>ld</string>", "<string>f</string>"),
  ],
  [
    "different argument type",
    (xml: string) => xml.replace("%ld item", "%d item"),
  ],
  [
    "multiple variables",
    (xml: string) => xml.replace("%#@itemCount@", "%#@itemCount@ %#@extra@"),
  ],
  [
    "format affixes",
    (xml: string) => xml.replace("%#@itemCount@", "There are %#@itemCount@"),
  ],
  [
    "positional argument",
    (xml: string) => xml.replace("%ld item", "%1$ld item"),
  ],
  ["argument width", (xml: string) => xml.replace("%ld item", "%02ld item")],
  [
    "additional argument",
    (xml: string) => xml.replace("%ld item", "%ld %@ item"),
  ],
  ["repeated count", (xml: string) => xml.replace("%ld item", "%ld %ld item")],
  [
    "device rule",
    (xml: string) =>
      xml.replace("NSStringPluralRuleType", "NSStringDeviceSpecificRuleType"),
  ],
  [
    "unknown metadata",
    (xml: string) => xml.replace("<key>itemCount</key>", "<key>unknown</key>"),
  ],
  [
    "duplicate property",
    (xml: string) => xml.replace("<key>one</key>", "<key>other</key>"),
  ],
  [
    "reserved reference",
    (xml: string) => xml.replace("%ld item", "[%key:greeting%] item"),
  ],
  ["markup", (xml: string) => xml.replace("%ld item", "<b>Bold</b> item")],
  [
    "entities",
    (xml: string) =>
      '<!DOCTYPE plist [<!ENTITY x SYSTEM "file:///never-read">]>' + xml,
  ],
] as const)
  test(`Apple native import rejects ${label} before saving`, () => {
    assert.throws(() => parseStringsDict(change(english)), /Apple stringsdict/);
  });
for (const text of [
  "{n, selectordinal, one {#st} other {#th}}",
  "{n, plural, offset:1 one {# item} other {# items}}",
  "{n, plural, =0 {None} other {# items}}",
  "{n, plural, other {{name} has # items}}",
  "{n, plural, other {# and # items}}",
])
  test(`native export rejects unsupported ICU: ${text}`, () =>
    assert.throws(
      () =>
        writeCatalog(
          new Map([["items", text]]),
          "stringsdict",
          "en",
          "en",
          new Map(),
        ),
      /Apple stringsdict/,
    ));

test("native resources reject literal Kieli reference markers rather than reinterpret copy", () => {
  assert.throws(
    () =>
      parseStringsDict(english.replace("%ld item", "[%key:greeting%] item")),
    /reference markers/,
  );
});
