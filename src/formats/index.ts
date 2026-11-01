export const fileFormats = [
  {
    id: "flat",
    label: "JSON · flat",
    extension: "json",
    group: "Web",
    note: "Dotted keys and string values.",
  },
  {
    id: "nested",
    label: "JSON · nested",
    extension: "json",
    group: "Web",
    note: "Dotted keys become nested objects. Conflicting paths are rejected.",
  },
  {
    id: "yaml",
    label: "YAML",
    extension: "yml",
    group: "Web",
    note: "String maps only; nested maps become dotted keys. No aliases or custom tags.",
  },
  {
    id: "js",
    label: "JavaScript",
    extension: "js",
    group: "Web",
    note: "A default export or module.exports containing literal string maps. Code is never executed.",
  },
  {
    id: "ts",
    label: "TypeScript",
    extension: "ts",
    group: "Web",
    note: "A default export containing literal string maps, including as const. Code is never executed.",
  },
  {
    id: "php",
    label: "PHP",
    extension: "php",
    group: "Web",
    note: "A return statement with a flat, single-quoted string array. No executable expressions.",
  },
  {
    id: "properties",
    label: "Java properties",
    extension: "properties",
    group: "Web",
    note: "String properties with escaped characters and Unicode escapes.",
  },
  {
    id: "ini",
    label: "INI",
    extension: "ini",
    group: "Web",
    note: "String values; sections become dotted keys. Export uses JSON-quoted values.",
  },
  {
    id: "resx",
    label: ".NET resources",
    extension: "resx",
    group: "Web",
    note: "String resources only. Typed objects, file references and binary data are rejected.",
  },
  {
    id: "po",
    label: "Gettext PO · keyed",
    extension: "po",
    group: "Web",
    note: "Key IDs in msgid and string translations in msgstr. Contexts and gettext plurals are not supported.",
  },
  {
    id: "pot",
    label: "Gettext POT · keyed template",
    extension: "pot",
    group: "Web",
    note: "Key IDs in msgid, with empty msgstr values. Templates intentionally omit translations.",
  },
  {
    id: "strings",
    label: "Apple strings",
    extension: "strings",
    group: "iOS",
    note: "Quoted key/value strings with comments and escaped Unicode.",
  },
  {
    id: "stringsdict",
    label: "Apple strings + plural dictionaries",
    extension: "stringsdict",
    group: "iOS",
    note: "Single-variable cardinal plurals with d/ld/lld counts; new counts default to d. Plain copy exports in companion .strings files. No nested rules, offsets, positional arguments or width/device variants.",
  },
  {
    id: "plist",
    label: "Apple property list",
    extension: "plist",
    group: "iOS",
    note: "XML dictionaries of strings. Binary plists, arrays and typed values are rejected.",
  },
  {
    id: "android",
    label: "Android string resources",
    extension: "xml",
    group: "Android",
    note: "Plain string resources. Rich markup, arrays and Android plural resources are rejected.",
  },
  {
    id: "arb",
    label: "Flutter ARB",
    extension: "arb",
    group: "Cross-platform",
    note: "String messages, including ICU syntax. ARB metadata is rejected because it cannot yet round-trip.",
  },
  {
    id: "xliff",
    label: "XLIFF 1.2",
    extension: "xliff",
    group: "Cross-platform",
    note: "Plain-text trans-unit entries with key IDs. Inline codes, groups and segmented XLIFF require a dedicated adapter.",
  },
  {
    id: "csv",
    label: "CSV",
    extension: "csv",
    group: "Cross-platform",
    note: "UTF-8 key,value columns, with RFC 4180 quoting. Spreadsheet formulas are exported as text.",
  },
] as const;
export type FileFormat = (typeof fileFormats)[number]["id"];
export const formatGroups = [
  "Web",
  "iOS",
  "Android",
  "Cross-platform",
] as const;
export const importExtensions =
  ".zip,.json,.yml,.yaml,.js,.ts,.php,.properties,.ini,.resx,.po,.pot,.strings,.stringsdict,.plist,.xml,.arb,.xliff,.xlf,.csv";
export function getFileFormat(id: string) {
  const format = fileFormats.find((format) => format.id === id);
  if (!format) throw new Error(`Unsupported file format: ${id}.`);
  return format;
}
export function detectFileFormat(filename: string): FileFormat {
  const extension = filename.split(".").at(-1)?.toLowerCase();
  if (extension === "json") return "flat";
  if (extension === "yaml") return "yaml";
  if (extension === "xlf") return "xliff";
  const format = fileFormats.find((format) => format.extension === extension);
  if (!format)
    throw new Error(
      `${filename}: this file format is not supported. See the supported format list.`,
    );
  return format.id;
}
export type ExportFile = { name: string; content: string };
