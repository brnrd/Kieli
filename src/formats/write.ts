import { parse, TYPE } from "@formatjs/icu-messageformat-parser";
import { looksPlural, readPlural } from "../messages";
import { stringify } from "yaml";
import { getFileFormat, type FileFormat, type ExportFile } from "./index";
import { nested, xml, type Catalog } from "./common";

const declaration = '<?xml version="1.0" encoding="UTF-8"?>\n';
const quote = (value: string) => JSON.stringify(value);
export function writeCatalog(
  catalog: Catalog,
  format: FileFormat,
  locale: string,
  sourceLanguage: string,
  source: Catalog,
): string {
  const entries = [...catalog];
  const flat = Object.fromEntries(entries);
  if (format === "flat") return JSON.stringify(flat, null, 2) + "\n";
  if (format === "nested")
    return JSON.stringify(nested(catalog), null, 2) + "\n";
  if (format === "yaml") return stringify(flat, { lineWidth: 0 });
  if (format === "arb")
    return JSON.stringify({ "@@locale": locale, ...flat }, null, 2) + "\n";
  if (format === "js" || format === "ts")
    return `export default ${JSON.stringify(flat, null, 2)}${format === "ts" ? " as const" : ""};\n`;
  if (format === "php") {
    const escape = (value: string) =>
      `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
    return `<?php\nreturn [\n${entries.map(([key, value]) => `    ${escape(key)} => ${escape(value)},`).join("\n")}\n];\n`;
  }
  if (format === "strings")
    return (
      entries
        .map(
          ([key, value]) =>
            `${quote(key)} = ${quote(value).replace(/\\(u[0-9a-fA-F]{4}|.)/g, (match, escape: string) => (escape.startsWith("u") ? `\\U${escape.slice(1)}` : match))};`,
        )
        .join("\n") + "\n"
    );
  if (format === "properties") {
    const escape = (value: string) =>
      value.replace(
        /[\\\n\r\t\f :!=#]/g,
        (char) =>
          ({ "\n": "\\n", "\r": "\\r", "\t": "\\t", "\f": "\\f" })[char] ??
          `\\${char}`,
      );
    return (
      entries
        .map(([key, value]) => `${escape(key)}=${escape(value)}`)
        .join("\n") + "\n"
    );
  }
  if (format === "ini")
    return (
      entries.map(([key, value]) => `${key}=${quote(value)}`).join("\n") + "\n"
    );
  if (format === "csv") {
    const cell = (value: string) => `"${value.replaceAll('"', '""')}"`;
    return (
      "key,value,encoding\r\n" +
      entries
        .map(([key, value]) => {
          const dangerous = /^[\s]*[=+@-]|^[\t\r\n]/.test(value);
          return [
            key,
            dangerous ? `'${value}` : value,
            dangerous ? "apostrophe" : "",
          ]
            .map(cell)
            .join(",");
        })
        .join("\r\n") +
      "\r\n"
    );
  }
  if (format === "po" || format === "pot") {
    if (
      entries.some(
        ([, value]) =>
          /[\u0000-\u0007\u000b\u000e-\u001f]/.test(value) ||
          !value.isWellFormed(),
      )
    )
      throw new Error(
        "Gettext cannot represent a control character or unpaired surrogate in this copy. Use JSON.",
      );
    const headers = `Content-Type: text/plain; charset=UTF-8\nLanguage: ${locale}\n`;
    return (
      `msgid ""\nmsgstr ${quote(headers)}\n\n` +
      entries
        .map(
          ([key, value]) =>
            `msgid ${quote(key)}\nmsgstr ${quote(format === "pot" ? "" : value)}\n`,
        )
        .join("\n")
    );
  }
  if (format === "android") {
    for (const [key] of entries)
      if (!/^[a-z][a-z0-9_]*$/.test(key))
        throw new Error(
          `Android resource name ${key} must use lowercase letters, digits and underscores. Keys are never silently renamed.`,
        );
    const escape = (value: string) =>
      xml(
        '"' +
          value
            .replaceAll("\\", "\\\\")
            .replaceAll('"', '\\"')
            .replaceAll("'", "\\'")
            .replaceAll("@", "\\@")
            .replaceAll("?", "\\?")
            .replaceAll("\n", "\\n")
            .replaceAll("\r", "\\r")
            .replaceAll("\t", "\\t") +
          '"',
      );
    return (
      declaration +
      `<resources>\n${entries
        .map(([key, value]) => {
          if (!looksPlural(value))
            return `  <string name="${xml(key)}">${escape(value)}</string>`;
          const plural = readPlural(value);
          if (
            !plural ||
            plural.type !== "cardinal" ||
            plural.offset ||
            Object.keys(plural.forms).some((form) => form.startsWith("="))
          )
            throw new Error(
              `Android plural ${key} requires a single cardinal plural without offset or exact selectors. Use ICU JSON for complex messages.`,
            );
          const node = parse(value, { ignoreTag: true })[0]!;
          if (node.type !== TYPE.plural) throw new Error("Invalid plural.");
          const forms = Object.entries(node.options).map(([form, option]) => {
            const copy = option.value
              .map((part) => {
                if (part.type === TYPE.literal) return part.value;
                if (part.type === TYPE.pound) return "%d";
                throw new Error(
                  `Android plural ${key} contains nested ICU or named arguments. Use ICU JSON.`,
                );
              })
              .join("");
            return `    <item quantity="${form}">${escape(copy)}</item>`;
          });
          return `  <plurals name="${xml(key)}">\n${forms.join("\n")}\n  </plurals>`;
        })
        .join("\n")}\n</resources>\n`
    );
  }
  if (format === "resx")
    return (
      declaration +
      `<root>\n  <resheader name="resmimetype"><value>text/microsoft-resx</value></resheader>\n  <resheader name="version"><value>2.0</value></resheader>\n  <resheader name="reader"><value>System.Resources.ResXResourceReader, System.Windows.Forms</value></resheader>\n  <resheader name="writer"><value>System.Resources.ResXResourceWriter, System.Windows.Forms</value></resheader>\n${entries.map(([key, value]) => `  <data name="${xml(key)}" xml:space="preserve"><value>${xml(value)}</value></data>`).join("\n")}\n</root>\n`
    );
  if (format === "plist")
    return (
      declaration +
      `<plist version="1.0"><dict>\n${entries.map(([key, value]) => `  <key>${xml(key)}</key><string>${xml(value)}</string>`).join("\n")}\n</dict></plist>\n`
    );
  if (format === "xliff")
    return (
      declaration +
      `<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">\n  <file original="keylo" source-language="${xml(sourceLanguage)}" target-language="${xml(locale)}" datatype="plaintext"><body>\n${entries.map(([key, value]) => `    <trans-unit id="${xml(key)}" xml:space="preserve"><source>${xml(source.get(key) ?? "")}</source><target>${xml(value)}</target></trans-unit>`).join("\n")}\n  </body></file>\n</xliff>\n`
    );
  throw new Error("Unsupported export format.");
}

export function exportFiles(
  translations: Record<string, unknown>,
  format: string,
  sourceLanguage: string,
  source: Catalog,
): ExportFile[] {
  const definition = getFileFormat(format);
  let size = 0;
  return Object.entries(translations).map(([locale, values]) => {
    const catalog = new Map(Object.entries(values as Record<string, string>));
    // Nested JSON is already reconstructed by the service.
    const content =
      format === "nested"
        ? JSON.stringify(values, null, 2) + "\n"
        : writeCatalog(catalog, definition.id, locale, sourceLanguage, source);
    size += new TextEncoder().encode(content).length;
    if (size > 10 * 1024 * 1024)
      throw new Error(
        "Export exceeds 10 MB. Export fewer languages or split the project.",
      );
    return { name: `${locale}.${definition.extension}`, content };
  });
}
