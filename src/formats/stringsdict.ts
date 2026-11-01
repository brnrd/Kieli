import { DOMParser } from "@xmldom/xmldom";
import { parse, TYPE } from "@formatjs/icu-messageformat-parser";
import { PLURAL_CATEGORIES, readPlural, writePlural } from "../messages";
import { add, xml, type Catalog } from "./common";
import type { ApplePluralType } from "../shared";
const types = ["d", "ld", "lld"] as const;
const children = (node: Element) =>
  Array.from(node.childNodes).filter(
    (node): node is Element => node.nodeType === 1,
  );
function fail(message: string): never {
  throw new Error(`Apple stringsdict: ${message}`);
}
function plain(node: Element) {
  if (node.attributes.length || children(node).length)
    fail(
      "string/key values must contain plain text without attributes or markup.",
    );
  return node.textContent ?? "";
}
function dictionary(node: Element) {
  if (node.tagName !== "dict" || node.attributes.length)
    fail("expected a plain dictionary.");
  const values = children(node),
    result = new Map<string, Element>();
  if (values.length % 2) fail("dictionary entries must have a key and value.");
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index]!;
    if (key.tagName !== "key") fail("expected a dictionary key.");
    const name = plain(key);
    if (result.has(name)) fail(`duplicate dictionary key ${name}.`);
    result.set(name, values[index + 1]!);
  }
  if (
    Array.from(node.childNodes).some(
      (child) => [3, 4].includes(child.nodeType) && child.textContent?.trim(),
    )
  )
    fail("unexpected text in dictionary.");
  return result;
}
const string = (node: Element | undefined) =>
  node?.tagName === "string" ? plain(node) : fail("expected a string value.");
const literal = (value: string) =>
  value.replaceAll("'", "''").replace(/[{}#]+/g, (part) => `'${part}'`);
function nativeForm(value: string, type: ApplePluralType) {
  if (/\[%key(?:_id)?:/.test(value))
    fail(
      "literal Keylo reference markers are unsupported in native resources.",
    );
  let output = "",
    buffer = "",
    counts = 0;
  const flush = () => {
    output += literal(buffer);
    buffer = "";
  };
  for (let index = 0; index < value.length; index++) {
    if (value[index] !== "%") {
      buffer += value[index];
      continue;
    }
    if (value[index + 1] === "%") {
      buffer += "%";
      index++;
      continue;
    }
    if (value.slice(index).startsWith(`%${type}`)) {
      if (++counts > 1)
        fail(
          "use at most one count formatter per form; repeated/positional arguments are unsupported.",
        );
      flush();
      output += "#";
      index += type.length;
      continue;
    }
    fail(
      `only %% and the declared %${type} count formatter are supported. Use ICU JSON for other arguments, widths or positions.`,
    );
  }
  flush();
  return output;
}
export function parseStringsDict(text: string): {
  catalog: Catalog;
  types: Map<string, ApplePluralType>;
} {
  if (text.length > 10 * 1024 * 1024) fail("file exceeds 10 MB.");
  text = text.replace(/^\uFEFF/, "");
  text = text.replace(
    /<!DOCTYPE plist PUBLIC "-\/\/Apple\/\/DTD PLIST 1\.0\/\/EN" "https?:\/\/www\.apple\.com\/DTDs\/PropertyList-1\.0\.dtd">/,
    "",
  );
  if (/<!DOCTYPE|<!ENTITY/i.test(text))
    fail("DTDs and entities are not allowed.");
  const invalid = () => fail("malformed XML.");
  const document = new DOMParser({
    errorHandler: { warning: invalid, error: invalid, fatalError: invalid },
  }).parseFromString(text, "application/xml");
  const root = document.documentElement;
  if (
    !root ||
    root.tagName !== "plist" ||
    root.getAttribute("version") !== "1.0" ||
    root.attributes.length !== 1 ||
    children(root).length !== 1 ||
    Array.from(document.childNodes).filter((node) => node.nodeType === 1)
      .length !== 1
  )
    fail(
      "expected one XML plist version 1.0 dictionary; binary plists are unsupported.",
    );
  const catalog: Catalog = new Map(),
    countTypes = new Map<string, ApplePluralType>();
  for (const [key, node] of dictionary(children(root)[0]!)) {
    const entry = dictionary(node);
    const format = string(entry.get("NSStringLocalizedFormatKey"));
    const match = /^%#@([a-zA-Z_][a-zA-Z0-9_]*)@$/.exec(format);
    if (!match || entry.size !== 2 || !entry.has(match[1]!))
      fail(
        `${key}: use one standalone %#@variable@ cardinal plural. Affixes, positions, multiple variables and device/width rules are unsupported.`,
      );
    const variable = match![1]!,
      rule = dictionary(entry.get(variable)!);
    if (
      string(rule.get("NSStringFormatSpecTypeKey")) !== "NSStringPluralRuleType"
    )
      fail(`${key}: only NSStringPluralRuleType is supported.`);
    const type = string(rule.get("NSStringFormatValueTypeKey"));
    if (!types.includes(type as ApplePluralType))
      fail(`${key}: integer type must be d, ld or lld.`);
    const forms: Record<string, string> = Object.create(null);
    for (const [name, value] of rule) {
      if (
        ["NSStringFormatSpecTypeKey", "NSStringFormatValueTypeKey"].includes(
          name,
        )
      )
        continue;
      if (!PLURAL_CATEGORIES.includes(name as never))
        fail(`${key}: unsupported rule property ${name}.`);
      forms[name] = nativeForm(string(value), type as ApplePluralType);
    }
    if (!Object.hasOwn(forms, "other"))
      fail(`${key}: the other form is required.`);
    add(
      catalog,
      key,
      writePlural({ variable, type: "cardinal", offset: 0, forms }),
    );
    countTypes.set(key, type as ApplePluralType);
  }
  return { catalog, types: countTypes };
}
export function writeStringsDict(
  catalog: Catalog,
  countTypes: ReadonlyMap<string, ApplePluralType> = new Map(),
) {
  const entries = [...catalog].map(([key, value]) => {
    const message = readPlural(value);
    if (
      !message ||
      message.type !== "cardinal" ||
      message.offset ||
      !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(message.variable) ||
      Object.keys(message.forms).some(
        (form) => !PLURAL_CATEGORIES.includes(form as never),
      )
    )
      fail(
        `${key}: native export requires one cardinal plural without offsets, exact selectors or nested choices.`,
      );
    const type = countTypes.get(key) ?? "d";
    if (!types.includes(type))
      fail(`${key}: integer type must be d, ld or lld.`);
    const node = parse(value, { ignoreTag: true })[0]!;
    if (node.type !== TYPE.plural) fail(`${key}: invalid plural.`);
    const forms = Object.entries(node.options).map(([form, option]) => {
      let counts = 0;
      const copy = option.value
        .map((part) => {
          if (part.type === TYPE.literal)
            return part.value.replaceAll("%", "%%");
          if (part.type === TYPE.pound && ++counts <= 1) return `%${type}`;
          return fail(
            `${key}: forms allow literal text and at most one # count. Other arguments and nested ICU are unsupported.`,
          );
        })
        .join("");
      if (/\[%key(?:_id)?:/.test(copy))
        fail(
          `${key}: literal Keylo reference markers are unsupported in native resources.`,
        );
      return `      <key>${form}</key><string>${xml(copy)}</string>`;
    });
    return `  <key>${xml(key)}</key>\n  <dict>\n    <key>NSStringLocalizedFormatKey</key><string>%#@${xml(message!.variable)}@</string>\n    <key>${xml(message!.variable)}</key>\n    <dict>\n      <key>NSStringFormatSpecTypeKey</key><string>NSStringPluralRuleType</string>\n      <key>NSStringFormatValueTypeKey</key><string>${type}</string>\n${forms.join("\n")}\n    </dict>\n  </dict>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n${entries.join("\n")}\n</dict></plist>\n`;
}
