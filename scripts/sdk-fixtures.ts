import { mkdir, writeFile } from "node:fs/promises";
import { compileMessage, compileRules } from "../src/server/ota-messages";
const cases = [
  {
    locale: "en",
    messages: {
      hello: "Hello {name}",
      items: "{count, plural, =0 {None} one {# item} other {# items}}",
      rank: "{count, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}",
      nested:
        "{gender, select, male {He has {count, plural, one {one item} other {# items}}} other {They have items}}",
      quoted: "{count, plural, one {'#' item} other {# items}}",
      offset:
        "{count, plural, offset:1 =0 {None} one {You and one friend} other {You and # friends}}",
    },
    checks: [
      ["hello", { name: "Alice" }, "Hello Alice"],
      ["items", { count: "0" }, "None"],
      ["items", { count: "1" }, "1 item"],
      ["items", { count: "3" }, "3 items"],
      ["rank", { count: "22" }, "22nd"],
      ["rank", { count: "11" }, "11th"],
      ["nested", { gender: "male", count: "3" }, "He has 3 items"],
      ["quoted", { count: "1" }, "# item"],
      ["offset", { count: "2" }, "You and one friend"],
      ["offset", { count: "4" }, "You and 3 friends"],
      ["hello", {}, "FALLBACK"],
      ["unknown", {}, "FALLBACK"],
    ],
  },
  {
    locale: "ar",
    messages: {
      items:
        "{count, plural, zero {zero} one {one} two {two} few {few} many {many} other {other}}",
    },
    checks: [
      ["items", { count: "0" }, "zero"],
      ["items", { count: "1" }, "one"],
      ["items", { count: "2" }, "two"],
      ["items", { count: "3" }, "few"],
      ["items", { count: "11" }, "many"],
      ["items", { count: "100" }, "other"],
      ["items", { count: "1.5" }, "other"],
    ],
  },
  {
    locale: "ru",
    messages: {
      items: "{count, plural, one {one} few {few} many {many} other {other}}",
    },
    checks: [
      ["items", { count: "1" }, "one"],
      ["items", { count: "2" }, "few"],
      ["items", { count: "5" }, "many"],
      ["items", { count: "21" }, "one"],
      ["items", { count: "1.5" }, "other"],
    ],
  },
  {
    locale: "fr",
    messages: { items: "{count, plural, one {one} many {many} other {other}}" },
    checks: [
      ["items", { count: "0" }, "one"],
      ["items", { count: "1000000" }, "many"],
      ["items", { count: "2" }, "other"],
    ],
  },
];
const result = cases.map(({ locale, messages, checks }) => ({
  locale,
  checks,
  bundle: {
    schema: 1,
    project: "mobile",
    locale,
    release: "fixture",
    rules: {
      cardinal: compileRules(locale, "cardinal"),
      ordinal: compileRules(locale, "ordinal"),
    },
    messages: Object.fromEntries(
      Object.entries(messages).map(([key, value]) => [
        key,
        { value, nodes: compileMessage(value) },
      ]),
    ),
  },
}));
await mkdir("sdks/fixtures", { recursive: true });
const text = JSON.stringify(result, null, 2) + "\n";
await writeFile("sdks/fixtures/messages.json", text);
await mkdir("sdks/swift/Tests/KeyloTests/Fixtures", { recursive: true });
await writeFile("sdks/swift/Tests/KeyloTests/Fixtures/messages.json", text);
await mkdir("sdks/android/src/test/resources", { recursive: true });
await writeFile("sdks/android/src/test/resources/messages.json", text);
