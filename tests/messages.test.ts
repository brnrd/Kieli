import test from "node:test";
import assert from "node:assert/strict";
import {
  categories,
  readPlural,
  writePlural,
  completeMessage,
  resolveProject,
  exportPlural,
} from "../src/messages";
import { parseCatalog } from "../src/formats/parse";
import { writeCatalog } from "../src/formats/write";
import { parseSnapshot, parseBundle } from "../src/lokalise";
import { compileRules, compileMessage } from "../src/server/ota-messages";
import type { Project, TranslationKey } from "../src/shared";
const project = {
  languages: [
    { code: "en", name: "English" },
    { code: "ar", name: "Arabic" },
  ],
} as Project;
const key = (
  name: string,
  translations: Record<string, string>,
  plural = false,
) => ({ name, translations, plural }) as TranslationKey;
test("Unicode defaults include all six Arabic forms and project overrides keep other mandatory", () => {
  assert.deepEqual(categories("ar"), [
    "zero",
    "one",
    "two",
    "few",
    "many",
    "other",
  ]);
  assert.deepEqual(
    categories({ code: "ar", name: "Arabic", pluralForms: ["one", "other"] }),
    ["one", "other"],
  );
  assert.deepEqual(categories("en", "ordinal"), ["one", "two", "few", "other"]);
  assert.equal(
    completeMessage(
      "{count, plural, one {One} other {# items}}",
      { code: "en", name: "English" },
      true,
    ),
    true,
  );
  assert.equal(
    completeMessage(
      "{count, plural, one {One} other {# items}}",
      { code: "ar", name: "Arabic" },
      true,
    ),
    false,
  );
  assert.equal(
    completeMessage(
      "{count, plural, one {} other {# items}}",
      { code: "en", name: "English" },
      true,
    ),
    false,
  );
});
test("plural read/write retains quotes, nested selectors, exact values and offsets", () => {
  const text =
    "{count, plural, offset:1 =0 {None} one {'#' {name}} other {{gender, select, male {He} other {They}} have # items}}";
  assert.equal(writePlural(readPlural(text)!), text);
  assert.throws(
    () =>
      writePlural({
        variable: "count",
        type: "cardinal",
        offset: 0,
        forms: { other: "unbalanced }" },
      }),
    /syntax/,
  );
  assert.equal(readPlural("prefix " + text), undefined);
  const exported = readPlural(
    exportPlural("", project.languages[1]!, text, true),
  )!;
  assert.ok(exported.forms.few);
  assert.equal(exported.forms.few, readPlural(text)!.forms.other);
});
test("inline references update recursively, report missing copy and reject cycles, missing keys and plural targets", () => {
  const keys = [
    key("brand", { en: "Keylo", ar: "" }),
    key("title", { en: "Welcome to [%key:brand%]", ar: "[%key:brand%]" }),
    key("nested", { en: "[%key:title%]!" }),
  ];
  let resolved = resolveProject(keys, project);
  assert.equal(resolved[2]!.resolvedTranslations!.en, "Welcome to Keylo!");
  assert.match(resolved[1]!.referenceErrors!.ar!, /Missing/);
  keys[0]!.translations.en = "Updated";
  resolved = resolveProject(keys, project);
  assert.equal(resolved[1]!.resolvedTranslations!.en, "Welcome to Updated");
  assert.throws(
    () =>
      resolveProject(
        [key("a", { en: "[%key:b%]" }), key("b", { en: "[%key:a%]" })],
        project,
        true,
      ),
    /Circular/,
  );
  assert.throws(
    () => resolveProject([key("a", { en: "[%key:missing%]" })], project, true),
    /does not exist/,
  );
  assert.throws(
    () =>
      resolveProject(
        [
          key("a", { en: "[%key:b%]" }),
          key("b", { en: "{n,plural,other {#}}" }, true),
        ],
        project,
        true,
      ),
    /Plural key/,
  );
});
test("Lokalise IDs map to names and import dependencies precede references", () => {
  const preview = parseSnapshot({
    languages: [{ lang_iso: "en" }],
    keys: [
      {
        key_id: 2,
        key_name: "a",
        translations: [{ language_iso: "en", translation: "[%key_id:1%]" }],
      },
      {
        key_id: 1,
        key_name: "z",
        translations: [{ language_iso: "en", translation: "Brand" }],
      },
    ],
  });
  assert.deepEqual(
    preview.keys.map((k) => k.name),
    ["z", "a"],
  );
  assert.equal(preview.keys[1]!.translations.en, "[%key:z%]");
  const plural = parseBundle([
    { name: "en.json", text: '{"items":{"one":"One","other":"# items"}}' },
  ]);
  assert.equal(plural.keys[0]!.name, "items");
  assert.equal(plural.keys[0]!.plural, true);
});
test("Android native plurals and ICU JSON round-trip without form keys being flattened", () => {
  const input =
    '<resources><plurals name="items"><item quantity="one">One item</item><item quantity="other">%d items</item></plurals></resources>';
  const parsed = parseCatalog(input, "android", "en");
  assert.equal(readPlural(parsed.get("items")!)!.forms.other, "# items");
  const output = writeCatalog(parsed, "android", "en", "en", parsed);
  assert.match(output, /<plurals/);
  assert.match(output, /%d items/);
  assert.deepEqual([...parseCatalog(output, "android", "en")], [...parsed]);
  assert.equal(
    parseCatalog('{"items":{"one":"One","other":"# items"}}', "flat", "en")
      .size,
    1,
  );
  assert.throws(
    () =>
      writeCatalog(
        new Map([["items", "{n, plural, offset:1 other {#}}"]]),
        "android",
        "en",
        "en",
        new Map(),
      ),
    /offset/,
  );
});
test("OTA message tree preserves quoted literals, select and nested plurals; rejects unsupported formatters", () => {
  const tree = compileMessage(
    "{n, plural, one {'#'} other {{name} has # items}}",
  );
  assert.equal(tree[0]!.type, "plural");
  assert.equal(tree[0]!.options!.one![0]!.value, "#");
  assert.equal(tree[0]!.options!.other!.at(-2)!.type, "pound");
  assert.throws(() => compileMessage("{date,date,long}"), /Format dates/);
});
test("compiled CLDR predicates match Intl for cardinal and ordinal counts across languages and decimals", () => {
  for (const locale of [
    "en",
    "fr",
    "ar",
    "ru",
    "uk",
    "cs",
    "nb",
    "pl",
    "pt-PT",
    "cy",
    "br",
    "lv",
    "ja",
    "sl",
    "he",
  ])
    for (const type of ["cardinal", "ordinal"] as const) {
      const rules = compileRules(locale, type);
      const intl = new Intl.PluralRules(locale, { type });
      for (const n of [
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 20, 21, 22, 23, 24,
        25, 100, 101, 102, 111, 1000000, 0.1, 0.5, 1.1, 1.2, 2.5, 10.1,
      ]) {
        const fraction = String(n).split(".")[1] ?? "";
        const operands: Record<string, number> = {
          n,
          i: Math.floor(n),
          v: fraction.length,
          w: fraction.replace(/0+$/, "").length,
          f: Number(fraction),
          t: Number(fraction.replace(/0+$/, "")),
          e: 0,
          c: 0,
        };
        const actual =
          ["zero", "one", "two", "few", "many"].find((form) =>
            rules[form]?.some((group) =>
              group.every((relation) => {
                let value = operands[relation.operand]!;
                if (relation.mod) value %= relation.mod;
                const match =
                  Number.isInteger(value) &&
                  relation.ranges.some(([a, b]) => value >= a! && value <= b!);
                return relation.not ? !match : match;
              }),
            ),
          ) ?? "other";
        assert.equal(actual, intl.select(n), `${locale} ${type} ${n}`);
      }
    }
});
