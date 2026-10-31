import test from "node:test";
import assert from "node:assert/strict";
import { zipSync, strToU8 } from "fflate";
import { parseCatalog, csvRows } from "../src/formats/parse";
import { writeCatalog } from "../src/formats/write";
import { parseTranslationFiles } from "../src/formats/import";
import { fileFormats } from "../src/formats";
import { KeyloService } from "../src/server/service";
import { sqliteStore } from "../src/server/store";
import type { Identity } from "../src/shared";

const catalog = new Map([
  ["hello", '  Welcome {name}, "friend" & <visitor>!  '],
  ["multiline", "First line\nSecond\r\nline\tTabbed"],
  ["unicode", "日本語 · Українська · العربية · 😀"],
  ["escapes", String.raw`C:\new\folder\u0041's $value %@ %1$s`],
  ["empty", ""],
]);
for (const format of fileFormats) {
  test(`${format.label} preserves Unicode, interpolation, whitespace and literal escapes`, () => {
    const text = writeCatalog(catalog, format.id, "fr", "en", catalog);
    const parsed = parseCatalog(text, format.id, "fr");
    assert.deepEqual(
      parsed,
      format.id === "pot"
        ? new Map([...catalog].map(([key]) => [key, ""]))
        : catalog,
    );
  });
}

test("reads real-world literal modules, XML dictionaries, properties and quoted CSV", () => {
  assert.equal(
    parseCatalog(
      'export default { home: { title: "Welcome" } } as const;',
      "ts",
      "en",
    ).get("home.title"),
    "Welcome",
  );
  assert.equal(
    parseCatalog('module.exports = {hello: "Hello"};', "js", "en").get("hello"),
    "Hello",
  );
  assert.equal(
    parseCatalog(
      '/* context */ "hello" = "Bonjour\\U0020ami"; // greeting',
      "strings",
      "fr",
    ).get("hello"),
    "Bonjour ami",
  );
  assert.equal(
    parseCatalog(
      '<?xml version="1.0"?><resources><string name="welcome">Hello %1$s</string></resources>',
      "android",
      "en",
    ).get("welcome"),
    "Hello %1$s",
  );
  assert.equal(
    parseCatalog(
      '<plist version="1.0"><dict><key>home</key><dict><key>title</key><string>Hello &amp; welcome</string></dict></dict></plist>',
      "plist",
      "en",
    ).get("home.title"),
    "Hello & welcome",
  );
  assert.equal(
    parseCatalog("welcome = Bon\\u006aour\\\n  ami", "properties", "fr").get(
      "welcome",
    ),
    "Bonjourami",
  );
  assert.equal(
    parseCatalog('[home]\ntitle="  Bonjour  "', "ini", "fr").get("home.title"),
    "  Bonjour  ",
  );
  assert.equal(
    parseCatalog(
      'key,value\r\nhello,"Line 1\nLine 2, ""quote"""\r\n',
      "csv",
      "en",
    ).get("hello"),
    'Line 1\nLine 2, "quote"',
  );
  assert.equal(
    parseCatalog('msgid "hello"\nmsgstr "Bon"\n"jour"\n', "po", "fr").get(
      "hello",
    ),
    "Bonjour",
  );
});

test("CSV formula protection is reversible and does not eat genuine apostrophes", () => {
  const input = new Map([
    ["formula", '=HYPERLINK("https://example.invalid")'],
    ["space", "  +1"],
    ["tab", "\t=1"],
    ["apostrophe", "'=literal"],
    ["plain", "Normal copy"],
  ]);
  const text = writeCatalog(input, "csv", "en", "en", input);
  const rows = csvRows(text);
  assert.equal(rows[1]![1]!.startsWith("'="), true);
  assert.equal(rows[2]![2], "apostrophe");
  assert.deepEqual(parseCatalog(text, "csv", "en"), input);
});

test("all formats reject duplicate keys, prototype names, oversized copy and unsupported structures", () => {
  for (const format of [
    "flat",
    "yaml",
    "js",
    "php",
    "strings",
    "properties",
    "ini",
    "po",
    "csv",
    "plist",
    "resx",
    "android",
    "xliff",
  ] as const) {
    const valid = writeCatalog(
      new Map([["hello", "Hello"]]),
      format,
      "en",
      "en",
      new Map(),
    );
    const duplicate =
      format === "flat"
        ? '{"hello":"one","hello":"two"}'
        : format === "yaml"
          ? "hello: one\nhello: two"
          : format === "js"
            ? 'export default { hello:"one", hello:"two" }'
            : undefined;
    if (duplicate)
      assert.throws(
        () => parseCatalog(duplicate, format, "en"),
        /[Dd]uplicate|unique/,
      );
    assert.ok(valid);
  }
  assert.throws(() =>
    parseCatalog('{"__proto__":{"polluted":"yes"}}', "flat", "en"),
  );
  assert.throws(
    () =>
      parseCatalog(
        'export default {hello: (() => { throw new Error("executed") })()};',
        "js",
        "en",
      ),
    /literal/,
  );
  assert.throws(
    () => parseCatalog('import x from "remote"; export default x;', "ts", "en"),
    /single/,
  );
  assert.throws(
    () => parseCatalog("export default { ...other };", "js", "en"),
    /spreads/,
  );
  assert.throws(() => parseCatalog("a: &a [*a]", "yaml", "en"), /aliases/);
  assert.throws(() => parseCatalog("hello: !custom value", "yaml", "en"));
  assert.throws(
    () =>
      parseCatalog(
        '<!DOCTYPE root [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><root><data name="hello"><value>&xxe;</value></data></root>',
        "resx",
        "en",
      ),
    /entities/,
  );
  assert.throws(
    () =>
      parseCatalog(
        '<resources><string name="hello"><b>Hello</b></string></resources>',
        "android",
        "en",
      ),
    /markup/,
  );
  assert.throws(
    () =>
      parseCatalog(
        '<resources><plurals name="count"><item quantity="invalid">Items</item></plurals></resources>',
        "android",
        "en",
      ),
    /quantity/,
  );
  assert.throws(
    () =>
      parseCatalog(
        '<root><data name="file" type="System.Resources.ResXFileRef"><value>secret</value></data></root>',
        "resx",
        "en",
      ),
    /Typed/,
  );
  assert.throws(
    () =>
      parseCatalog(
        '{"hello":"Hi","@hello":{"description":"Context"}}',
        "arb",
        "en",
      ),
    /metadata/,
  );
  assert.throws(
    () =>
      parseCatalog(
        'msgid "item"\nmsgid_plural "items"\nmsgstr[0] "item"',
        "po",
        "en",
      ),
    /plural/,
  );
  assert.throws(
    () =>
      parseCatalog(
        "<?php return ['hello' => shell_exec('whoami')];",
        "php",
        "en",
      ),
    /never executed/,
  );
  assert.throws(
    () => parseCatalog("hello=" + "a".repeat(20001), "properties", "en"),
    /20,000/,
  );
  assert.throws(
    () =>
      writeCatalog(
        new Map([["home.title", "Hello"]]),
        "android",
        "en",
        "en",
        new Map(),
      ),
    /resource name/,
  );
  assert.throws(
    () =>
      writeCatalog(
        new Map([["hello", "x\u0000y"]]),
        "resx",
        "en",
        "en",
        new Map(),
      ),
    /control character/,
  );
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("mixed format ZIP previews merge locales, infer Apple/Android directories and fail closed", () => {
  const preview = parseTranslationFiles(
    zipSync({
      "en.lproj/Localizable.strings": strToU8('"hello" = "Hello";'),
      "values-fr/strings.xml": strToU8(
        '<resources><string name="hello">Bonjour</string></resources>',
      ),
      "nl.yml": strToU8("hello: Hallo"),
    }),
    "website.zip",
  );
  assert.equal(preview.sourceLanguage, "en");
  assert.deepEqual(preview.keys[0]!.translations, {
    en: "Hello",
    fr: "Bonjour",
    nl: "Hallo",
  });
  assert.equal(preview.keys.length, 1);
  assert.throws(
    () =>
      parseTranslationFiles(
        zipSync({ "../en.json": strToU8("{}") }),
        "bad.zip",
      ),
    /Unsafe/,
  );
  assert.throws(
    () =>
      parseTranslationFiles(
        zipSync({
          "en.json": strToU8('{"hello":"One"}'),
          "en.yml": strToU8("hello: Two"),
        }),
        "bad.zip",
      ),
    /Duplicate en/,
  );
  assert.throws(
    () =>
      parseTranslationFiles(
        zipSync({
          "fr.json": strToU8('{"hello":"One"}'),
          "layout.docx": strToU8("no"),
        }),
        "bad.zip",
      ),
    /not supported/,
  );
  assert.throws(
    () =>
      parseTranslationFiles(strToU8('"hello" = "Hi";'), "Localizable.strings"),
    /language not found/,
  );
  assert.equal(
    parseTranslationFiles(
      strToU8('"hello" = "Hi";'),
      "Localizable.strings",
      "en",
    ).languages[0]!.code,
    "en",
  );
  assert.throws(
    () =>
      parseTranslationFiles(new Uint8Array(10 * 1024 * 1024 + 1), "en.json"),
    /10 MB/,
  );
});

test("format exports retain authorization, explicit fallback, deterministic filenames and clear errors", async () => {
  const service = new KeyloService(await sqliteStore(":memory:"));
  const admin: Identity = {
    sub: "admin",
    name: "Admin",
    email: "admin@example.com",
    admin: true,
    projects: {},
  };
  await service.createProject(admin, {
    id: "site",
    name: "Site",
    sourceLanguage: "en",
    languages: [
      { code: "en", name: "English" },
      { code: "fr", name: "French" },
    ],
  });
  await service.createKey(admin, "site", {
    name: "hello",
    translations: { en: "Hello {name}", fr: "" },
  });
  const user: Identity = { ...admin, admin: false, projects: { site: "user" } };
  const exported = await service.export(
    user,
    "site",
    ["fr", "fr"],
    "xliff",
    true,
  );
  assert.equal(exported.files.length, 1);
  assert.equal(exported.files[0]!.name, "fr.xliff");
  assert.match(
    exported.files[0]!.content,
    /source-language="en" target-language="fr"/,
  );
  assert.match(exported.files[0]!.content, /<target>Hello \{name\}<\/target>/);
  const empty = await service.export(user, "site", ["fr"], "yaml", false);
  assert.equal(
    parseCatalog(empty.files[0]!.content, "yaml", "fr").get("hello"),
    "",
  );
  await assert.rejects(
    service.export({ ...user, projects: {} }, "site", [], "yaml", false),
    (error) => (error as { status: number }).status === 403,
  );
  await assert.rejects(
    service.export(user, "site", ["de"], "yaml", false),
    (error) => (error as { status: number }).status === 400,
  );
});
