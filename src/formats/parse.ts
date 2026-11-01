import { parseStringsDict } from "./stringsdict";
import { writePlural, PLURAL_CATEGORIES } from "../messages";
import { DOMParser } from "@xmldom/xmldom";
import { parseDocument, isAlias, visit } from "yaml";
import { parse as parseJavaScript } from "@babel/parser";
import {
  add,
  canonicalLocale,
  flatten,
  isObject,
  unescapeQuoted,
  type Catalog,
} from "./common";
import type { FileFormat } from "./index";

const children = (node: Element) =>
  Array.from(node.childNodes).filter(
    (node): node is Element => node.nodeType === 1,
  );
function plain(node: Element) {
  if (children(node).length)
    throw new Error(
      "Inline XML markup is not supported. Export plain strings or use JSON.",
    );
  return node.textContent ?? "";
}
function exactChildren(node: Element, allowed: string[]) {
  if (children(node).some((child) => !allowed.includes(child.localName)))
    throw new Error(
      `Unsupported element inside ${node.localName}. No data was imported.`,
    );
}
function attribute(node: Element, name: string) {
  const value = node.getAttribute(name);
  if (!value)
    throw new Error(`Missing ${name} attribute on ${node.localName}.`);
  return value;
}
function parseXml(text: string, format: FileFormat, locale: string): Catalog {
  // Accept only Apple's fixed, well-known plist declaration; never resolve a DTD.
  text = text.replace(
    /<!DOCTYPE plist PUBLIC "-\/\/Apple\/\/DTD PLIST 1\.0\/\/EN" "https?:\/\/www\.apple\.com\/DTDs\/PropertyList-1\.0\.dtd">/,
    "",
  );
  if (/<!DOCTYPE|<!ENTITY/i.test(text))
    throw new Error("XML DTDs and entities are not allowed.");
  const invalid = () => {
    throw new Error("Malformed XML file.");
  };
  const document = new DOMParser({
    errorHandler: { warning: invalid, error: invalid, fatalError: invalid },
  }).parseFromString(text, "application/xml");
  const root = document.documentElement;
  if (
    !root ||
    Array.from(document.childNodes).filter((n) => n.nodeType === 1).length !== 1
  )
    return invalid();
  const result: Catalog = new Map();
  if (format === "android") {
    if (root.localName !== "resources")
      throw new Error(
        "Expected Android <resources>. Choose XLIFF for .xlf files.",
      );
    exactChildren(root, ["string", "plurals"]);
    const decode = (item: Element) => {
      if (
        Array.from(item.attributes).some(
          (attribute) =>
            !["name", "translatable", "formatted", "xml:space"].includes(
              attribute.name,
            ),
        )
      )
        throw new Error("Unsupported Android string metadata.");
      if (item.getAttribute("translatable") === "false")
        throw new Error(
          "Non-translatable Android resources cannot be preserved. Remove them from this import.",
        );
      if (item.getAttribute("formatted") === "false")
        throw new Error(
          "Android formatted=false metadata cannot yet round-trip.",
        );
      const value = plain(item);
      // Android's outer quotes preserve leading/trailing whitespace.
      const quoted = value.startsWith('"') && value.endsWith('"');
      if (
        !quoted &&
        (/^\s|\s$|\s{2,}/.test(value) ||
          /["']/.test(value.replace(/\\["']/g, "")))
      )
        throw new Error(
          "Android whitespace or quotes require a quoted string value. Export JSON to preserve complex strings.",
        );
      const body = quoted ? value.slice(1, -1) : value;
      if (/^[?@]/.test(body))
        throw new Error(
          "Android resource references cannot be imported as copy. Escape literal @ or ? characters.",
        );
      if (/(?:^|[^\\])(?:\\\\)*\\$/.test(body))
        throw new Error("Unfinished Android string escape.");
      return body.replace(
        /\\(u[0-9a-fA-F]{4}|[\s\S])/g,
        (match, escape: string) => {
          if (["@", "?", "'"].includes(escape)) return escape;
          return unescapeQuoted(match);
        },
      );
    };
    for (const item of children(root)) {
      if (item.localName === "string")
        add(result, attribute(item, "name"), decode(item));
      else {
        exactChildren(item, ["item"]);
        if (
          Array.from(item.attributes).some(
            (attribute) => attribute.name !== "name",
          )
        )
          throw new Error("Unsupported Android plural metadata.");
        const forms: Record<string, string> = {};
        for (const form of children(item)) {
          const category = attribute(form, "quantity");
          if (
            !PLURAL_CATEGORIES.includes(category as never) ||
            Object.hasOwn(forms, category)
          )
            throw new Error("Invalid or duplicate Android plural quantity.");
          if (
            Array.from(form.attributes).some(
              (attribute) => attribute.name !== "quantity",
            )
          )
            throw new Error("Unsupported Android plural item metadata.");
          // The count formatter is the only native argument we can map without renaming variables.
          const copy = plain(form);
          const shadow = document.createElement("string");
          shadow.appendChild(document.createTextNode(copy));
          forms[category] = decode(shadow).replace(
            /%(?:1\$)?d|['{}#]/g,
            (match) =>
              match.startsWith("%")
                ? "#"
                : match === "'"
                  ? "''"
                  : `\'${match}\'`,
          );
        }
        add(
          result,
          attribute(item, "name"),
          writePlural({
            variable: "count",
            type: "cardinal",
            offset: 0,
            forms,
          }),
        );
      }
    }
  } else if (format === "resx") {
    if (root.localName !== "root") throw new Error("Expected a .resx <root>.");
    exactChildren(root, ["data", "resheader", "schema"]);
    for (const item of children(root).filter(
      (node) => node.localName === "data",
    )) {
      if (item.hasAttribute("type") || item.hasAttribute("mimetype"))
        throw new Error("Typed or binary RESX resources are not supported.");
      exactChildren(item, ["value"]);
      const values = children(item);
      if (values.length !== 1)
        throw new Error("Each RESX resource must contain one string value.");
      add(result, attribute(item, "name"), plain(values[0]!));
    }
  } else if (format === "plist") {
    if (
      root.localName !== "plist" ||
      children(root).length !== 1 ||
      children(root)[0]!.localName !== "dict"
    )
      throw new Error("Expected an XML plist containing one dictionary.");
    function dictionary(node: Element, prefix = "", depth = 0) {
      if (depth > 32) throw new Error("Plist nesting exceeds 32 levels.");
      const items = children(node);
      if (items.length % 2) throw new Error("Invalid plist dictionary.");
      const names = new Set<string>();
      for (let i = 0; i < items.length; i += 2) {
        if (items[i]!.localName !== "key")
          throw new Error("Expected a plist key.");
        const name = plain(items[i]!);
        if (names.has(name)) throw new Error(`Duplicate plist key: ${name}.`);
        names.add(name);
        const key = prefix ? `${prefix}.${name}` : name;
        const value = items[i + 1]!;
        if (value.localName === "dict") dictionary(value, key, depth + 1);
        else if (value.localName === "string") add(result, key, plain(value));
        else
          throw new Error(
            "Only string dictionaries can be imported from plists.",
          );
      }
    }
    dictionary(children(root)[0]!);
  } else {
    if (root.localName !== "xliff" || root.getAttribute("version") !== "1.2")
      throw new Error("Only plain-text XLIFF 1.2 is supported.");
    exactChildren(root, ["file"]);
    for (const file of children(root)) {
      const target = file.getAttribute("target-language");
      if (target && canonicalLocale(target) !== locale)
        throw new Error(
          "XLIFF target-language does not match the selected file language.",
        );
      exactChildren(file, ["body"]);
      if (children(file).length !== 1)
        throw new Error("Expected one XLIFF body per file.");
      const body = children(file)[0]!;
      exactChildren(body, ["trans-unit"]);
      for (const unit of children(body)) {
        exactChildren(unit, ["source", "target"]);
        const sources = children(unit).filter((n) => n.localName === "source");
        const targets = children(unit).filter((n) => n.localName === "target");
        if (sources.length !== 1 || targets.length > 1)
          throw new Error("Expected one XLIFF source and at most one target.");
        // Validate source markup too; unsupported inline codes must never disappear.
        const source = plain(sources[0]!);
        add(
          result,
          attribute(unit, "id"),
          targets[0] ? plain(targets[0]) : source,
        );
      }
    }
  }
  return result;
}

function literalModule(text: string, typescript: boolean) {
  const ast = parseJavaScript(text, {
    sourceType: "module",
    plugins: typescript ? ["typescript"] : [],
  });
  if (ast.program.body.length !== 1)
    throw new Error(
      "Use a single default export or module.exports string map. Executable statements are rejected.",
    );
  const statement = ast.program.body[0]!;
  let value;
  if (statement.type === "ExportDefaultDeclaration")
    value = statement.declaration;
  else if (
    statement.type === "ExpressionStatement" &&
    statement.expression.type === "AssignmentExpression" &&
    statement.expression.operator === "=" &&
    statement.expression.left.type === "MemberExpression" &&
    !statement.expression.left.computed &&
    statement.expression.left.object.type === "Identifier" &&
    statement.expression.left.object.name === "module" &&
    statement.expression.left.property.type === "Identifier" &&
    statement.expression.left.property.name === "exports"
  )
    value = statement.expression.right;
  else
    throw new Error(
      "Use export default { ... } or module.exports = { ... }. Code is never executed.",
    );
  type AstNode = {
    type: string;
    expression?: AstNode;
    properties?: AstNode[];
    computed?: boolean;
    shorthand?: boolean;
    key?: { type: string; name?: string; value?: string };
    value?: unknown;
  };
  function read(node: AstNode, depth = 0): unknown {
    if (depth > 32) throw new Error("Module nesting exceeds 32 levels.");
    if (
      ["TSAsExpression", "TSSatisfiesExpression"].includes(node.type) &&
      node.expression
    )
      return read(node.expression, depth + 1);
    if (node.type === "StringLiteral") return node.value;
    if (node.type !== "ObjectExpression")
      throw new Error(
        "Only literal string maps are supported. Functions, variables, templates and imports are rejected.",
      );
    const result: Record<string, unknown> = Object.create(null);
    for (const property of node.properties ?? []) {
      if (
        property.type !== "ObjectProperty" ||
        property.computed ||
        property.shorthand ||
        !property.key ||
        !["Identifier", "StringLiteral"].includes(property.key.type)
      )
        throw new Error(
          "Computed properties, spreads and methods are not supported.",
        );
      const name = property.key.name ?? property.key.value!;
      if (Object.hasOwn(result, name))
        throw new Error(`Duplicate key: ${name}.`);
      result[name] = read(property.value as AstNode, depth + 1);
    }
    return result;
  }
  return flatten(read(value as unknown as AstNode));
}

function appleStrings(text: string): Catalog {
  const result: Catalog = new Map();
  let offset = 0;
  function skip() {
    const matched = /^(?:\s+|\/\*[\s\S]*?\*\/|\/\/[^\n]*(?:\n|$))*/.exec(
      text.slice(offset),
    )![0];
    offset += matched.length;
  }
  function string() {
    skip();
    const match = /^"((?:[^"\\\r\n]|\\[^\r\n])*)"/.exec(text.slice(offset));
    if (!match) throw new Error("Expected a quoted Apple string.");
    offset += match[0].length;
    return unescapeQuoted(match[1]!);
  }
  function punctuation(value: string) {
    skip();
    if (text[offset++] !== value)
      throw new Error(`Expected ${value} in Apple strings file.`);
  }
  while (true) {
    skip();
    if (offset === text.length) break;
    const key = string();
    punctuation("=");
    const value = string();
    punctuation(";");
    add(result, key, value);
  }
  return result;
}

function properties(text: string, ini: boolean): Catalog {
  const result: Catalog = new Map();
  let section = "";
  let continuation = "";
  let continuing = false;
  const decode = (value: string) =>
    value.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, escape: string) => {
      if (escape === "u") throw new Error("Invalid Unicode property escape.");
      return escape.startsWith("u")
        ? String.fromCharCode(parseInt(escape.slice(1), 16))
        : ({ n: "\n", r: "\r", t: "\t", f: "\f" }[escape] ?? escape);
    });
  for (let line of text.split(/\r\n|\n|\r/)) {
    if (continuing) line = continuation + line.trimStart();
    if (!ini && /(?<!\\)(?:\\\\)*\\$/.test(line)) {
      continuation = line.slice(0, -1);
      continuing = true;
      continue;
    }
    continuation = "";
    continuing = false;
    const trimmed = line.trimStart();
    if (!trimmed || /^[#!;]/.test(trimmed)) continue;
    if (ini && trimmed.startsWith("[")) {
      const match = /^\[([a-zA-Z0-9_.-]+)\]\s*$/.exec(trimmed);
      if (!match) throw new Error("Invalid INI section.");
      section = match[1]!;
      continue;
    }
    const match = ini
      ? /^([^=]+?)\s*=\s*(.*)$/.exec(trimmed)
      : /^((?:\\.|[^\s:=])+)(?:\s*[:=]\s*|\s+)?(.*)$/.exec(trimmed);
    if (!match) throw new Error("Expected a key/value property.");
    const key = ini ? match[1]!.trim() : decode(match[1]!);
    let value = match[2]!;
    if (ini) {
      value = value.trimEnd();
      if (value.startsWith('"')) {
        const parsed: unknown = JSON.parse(value);
        if (typeof parsed !== "string")
          throw new Error("INI values must be strings.");
        value = parsed;
      } else if (value.startsWith("'")) {
        if (!value.endsWith("'")) throw new Error("Unclosed INI quote.");
        value = value.slice(1, -1);
      } else if (/[;#]/.test(value))
        throw new Error("Quote INI values containing comment markers.");
    } else value = decode(value);
    add(result, section ? `${section}.${key}` : key, value);
  }
  if (continuing) throw new Error("Unfinished property continuation.");
  return result;
}

export function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    field = "",
    quoted = false,
    closed = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else field += char;
    } else if (char === '"') {
      if (field || closed) throw new Error("Unexpected CSV quote.");
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
      closed = false;
    } else if (char === "\r" || char === "\n") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      closed = false;
    } else {
      if (closed) throw new Error("Unexpected character after CSV quote.");
      field += char;
    }
  }
  if (quoted) throw new Error("Unclosed CSV quote.");
  if (field || row.length || closed) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function keyedPo(text: string): Catalog {
  const result: Catalog = new Map();
  let entry: Record<string, string> = Object.create(null),
    field = "";
  function flush() {
    if (!Object.keys(entry).length) return;
    if (!Object.hasOwn(entry, "msgid") || !Object.hasOwn(entry, "msgstr"))
      throw new Error("Each PO entry needs msgid and msgstr.");
    if (entry.msgctxt)
      throw new Error(
        "Gettext contexts cannot yet round-trip. Use keyed msgid catalogs or JSON.",
      );
    if (entry.msgid) add(result, entry.msgid, entry.msgstr!);
    else if (entry.msgstr && /charset=(?!UTF-8)[^\\\s]+/i.test(entry.msgstr))
      throw new Error("Use UTF-8 PO files.");
    entry = Object.create(null);
    field = "";
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      flush();
      continue;
    }
    if (/^#~|^#,.*\bfuzzy\b/.test(trimmed))
      throw new Error(
        "Obsolete or fuzzy gettext entries cannot yet round-trip. Resolve them before importing.",
      );
    if (trimmed.startsWith("#")) continue;
    if (/^msgid_plural|^msgstr\[/.test(trimmed))
      throw new Error(
        "Gettext plural entries are not supported. Use ICU messages in ARB or JSON.",
      );
    const match = /^(?:(msgid|msgstr|msgctxt)\s+)?("(?:[^"\\]|\\.)*")$/.exec(
      trimmed,
    );
    if (!match) throw new Error("Invalid keyed PO entry.");
    if (match[1]) {
      if (match[1] === "msgid" && Object.hasOwn(entry, "msgstr")) flush();
      field = match[1];
      if (Object.hasOwn(entry, field))
        throw new Error(`Duplicate ${field} field in PO entry.`);
      entry[field] = "";
    }
    if (!field) throw new Error("Unexpected PO continuation.");
    entry[field] += unescapeQuoted(match[2]!.slice(1, -1));
  }
  flush();
  return result;
}

function php(text: string): Catalog {
  const result: Catalog = new Map();
  const begin = /^\s*<\?php\s+return\s*\[/.exec(text);
  if (!begin)
    throw new Error(
      "Use <?php return [ 'key' => 'value' ]; with single-quoted strings.",
    );
  let rest = text.slice(begin[0].length);
  while (true) {
    rest = rest.trimStart();
    if (/^\]\s*;\s*(?:\?>\s*)?$/.test(rest)) return result;
    const match =
      /^'((?:[^'\\]|\\[\s\S])*)'\s*=>\s*'((?:[^'\\]|\\[\s\S])*)'\s*(,?)/.exec(
        rest,
      );
    if (!match)
      throw new Error(
        "Only flat PHP arrays of single-quoted strings are supported. Expressions are never executed.",
      );
    const decode = (value: string) => value.replace(/\\(['\\])/g, "$1");
    add(result, decode(match[1]!), decode(match[2]!));
    rest = rest.slice(match[0].length);
    if (!match[3] && !/^\s*\]/.test(rest))
      throw new Error("Expected a comma between PHP translations.");
  }
}

export function parseCatalog(
  text: string,
  format: FileFormat,
  locale: string,
): Catalog {
  text = text.replace(/^\uFEFF/, "");
  if (text.length > 10 * 1024 * 1024)
    throw new Error("Translation file exceeds 10 MB.");
  if (format === "stringsdict") return parseStringsDict(text).catalog;
  if (["flat", "nested", "arb", "yaml"].includes(format)) {
    if (format !== "yaml") JSON.parse(text); // YAML's JSON schema must not admit non-JSON syntax.
    const document = parseDocument(text, {
      uniqueKeys: true,
      schema: format === "yaml" ? "core" : "json",
      customTags: [],
    });
    if (document.errors.length || document.warnings.length)
      throw new Error(
        document.errors[0]?.message ?? document.warnings[0]!.message,
      );
    visit(document, (_, node) => {
      if (isAlias(node) || (isObject(node) && (node.anchor || node.tag)))
        throw new Error(
          "YAML aliases, anchors and explicit tags are not supported.",
        );
    });
    const value: unknown = document.toJS({ maxAliasCount: 0 });
    if (format === "arb" && isObject(value)) {
      for (const key of Object.keys(value))
        if (key.startsWith("@") && key !== "@@locale")
          throw new Error(
            "ARB metadata cannot yet round-trip. Remove metadata entries or use a string-only ARB export.",
          );
      if (
        value["@@locale"] &&
        canonicalLocale(String(value["@@locale"])) !== locale
      )
        throw new Error("ARB @@locale does not match the file language.");
      delete value["@@locale"];
    }
    return flatten(value);
  }
  if (["android", "resx", "plist", "xliff"].includes(format))
    return parseXml(text, format, locale);
  if (format === "js" || format === "ts")
    return literalModule(text, format === "ts");
  if (format === "strings") return appleStrings(text);
  if (format === "properties" || format === "ini")
    return properties(text, format === "ini");
  if (format === "po" || format === "pot") return keyedPo(text);
  if (format === "php") return php(text);
  if (format === "csv") {
    const rows = csvRows(text);
    const header = rows.shift();
    if (
      !header ||
      !["key,value", "key,value,encoding"].includes(header.join(","))
    )
      throw new Error(
        "CSV must have key,value columns, optionally followed by encoding.",
      );
    const result: Catalog = new Map();
    for (const row of rows) {
      if (row.length !== header.length)
        throw new Error("CSV row has the wrong number of columns.");
      if (row[2] && (row[2] !== "apostrophe" || !row[1]!.startsWith("'")))
        throw new Error("Unknown CSV text encoding.");
      add(
        result,
        row[0]!,
        row[2] === "apostrophe" ? row[1]!.slice(1) : row[1]!,
      );
    }
    return result;
  }
  throw new Error("Unsupported translation format.");
}
