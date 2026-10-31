import { unzipSync } from "fflate";
import {
  validateImportPreview,
  type ImportPreview,
  type ImportKey,
} from "../lokalise";
import { canonicalLocale } from "./common";
import { detectFileFormat, getFileFormat } from "./index";
import { parseCatalog } from "./parse";

const MAX_FILE = 10 * 1024 * 1024;
const MAX_TOTAL = 25 * 1024 * 1024;
function fileLanguage(name: string, text: string, hint: string) {
  if (hint) return canonicalLocale(hint);
  const parts = name.split("/");
  const basename = parts.at(-1)!.replace(/\.[^.]+$/, "");
  const candidates = [
    basename,
    ...parts
      .slice(0, -1)
      .reverse()
      .map((part) =>
        part
          .replace(/\.lproj$/, "")
          .replace(/^values-/, "")
          .replace(/-r([A-Z]{2})$/, "-$1"),
      ),
  ];
  for (const candidate of candidates) {
    if (/^[a-zA-Z]{2,3}(?:[-_][a-zA-Z0-9]{2,8})*$/.test(candidate)) {
      try {
        return canonicalLocale(candidate);
      } catch {
        /* Try an embedded language. */
      }
    }
  }
  const format = detectFileFormat(name);
  if (format === "arb") {
    const json: unknown = JSON.parse(text);
    if (
      json &&
      typeof json === "object" &&
      "@@locale" in json &&
      typeof json["@@locale"] === "string"
    )
      return canonicalLocale(json["@@locale"]);
  }
  if (format === "xliff") {
    const match = /\btarget-language\s*=\s*["']([^"']+)["']/.exec(text);
    if (match) return canonicalLocale(match[1]!);
  }
  throw new Error(
    `${name}: language not found. Name files en.json, fr.strings, etc., use locale directories, or enter a file language.`,
  );
}

export function parseTranslationFiles(
  bytes: Uint8Array,
  filename: string,
  languageHint = "",
  allowExternalReferences = false,
): ImportPreview {
  if (bytes.length > MAX_FILE)
    throw new Error("Choose a file smaller than 10 MB.");
  let files: [string, Uint8Array][];
  let ignored = 0;
  if (/\.zip$/i.test(filename)) {
    let total = 0,
      count = 0;
    const names = new Set<string>();
    const archive = unzipSync(bytes, {
      filter(entry) {
        if (++count > 1000)
          throw new Error("ZIP contains more than 1,000 entries.");
        if (
          entry.name.includes("..") ||
          entry.name.startsWith("/") ||
          entry.name.includes("\\") ||
          /^[A-Za-z]:/.test(entry.name) ||
          /[\x00-\x1f]/.test(entry.name)
        )
          throw new Error("Unsafe ZIP path.");
        if (names.has(entry.name)) throw new Error("Duplicate ZIP filename.");
        names.add(entry.name);
        if (
          entry.name.endsWith("/") ||
          entry.name.startsWith("__MACOSX/") ||
          entry.name.split("/").at(-1) === ".DS_Store"
        ) {
          ignored++;
          return false;
        }
        detectFileFormat(entry.name); // Reject unknown payloads before allocating their contents.
        total += entry.originalSize;
        if (entry.originalSize > MAX_FILE || total > MAX_TOTAL)
          throw new Error(
            "ZIP exceeds the 25 MB uncompressed limit or 10 MB per-file limit.",
          );
        return true;
      },
    });
    files = Object.entries(archive);
  } else {
    detectFileFormat(filename);
    files = [[filename, bytes]];
  }
  const keys = new Map<string, ImportKey>();
  const languages = new Map<string, { code: string; name: string }>();
  const warnings = new Set<string>();
  let total = 0;
  for (const [name, data] of files) {
    total += data.length;
    if (data.length > MAX_FILE || total > MAX_TOTAL)
      throw new Error(
        "Uncompressed translation files exceed the import limit.",
      );
    let text: string;
    if (data[0] === 0xff && data[1] === 0xfe)
      text = new TextDecoder("utf-16le", { fatal: true }).decode(data);
    else if (data[0] === 0xfe && data[1] === 0xff)
      text = new TextDecoder("utf-16be", { fatal: true }).decode(data);
    else text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    const locale = fileLanguage(
      name,
      text,
      files.length === 1 ? languageHint : "",
    );
    languages.set(locale, {
      code: locale,
      name:
        new Intl.DisplayNames(["en"], { type: "language" }).of(locale) ??
        locale,
    });
    if (languages.size > 30)
      throw new Error("Import up to 30 languages per project.");
    const format = detectFileFormat(name);
    try {
      for (const [key, value] of parseCatalog(text, format, locale)) {
        if (!keys.has(key) && keys.size >= 50000)
          throw new Error("Import up to 50,000 keys per project.");
        const entry = keys.get(key) ?? {
          name: key,
          namespace: key.includes(".") ? key.split(".")[0]! : "general",
          description: "",
          tags: [],
          translations: {},
        };
        if (Object.hasOwn(entry.translations, locale))
          throw new Error(`Duplicate ${locale} translation for ${key}.`);
        entry.translations[locale] = value;
        keys.set(key, entry);
      }
    } catch (error) {
      throw new Error(`${name}: ${(error as Error).message}`);
    }
    if (!["flat", "nested", "yaml", "js", "ts", "csv"].includes(format))
      warnings.add(
        `${getFileFormat(format).label}: imports key/value text. Original comments, formatting and file headers are not retained.`,
      );
  }
  if (ignored)
    warnings.add(
      `${ignored} ZIP directories or macOS metadata entries ignored.`,
    );
  return validateImportPreview(
    {
      name: filename.replace(/\.[^.]+$/, "").replace(/[-_]/g, " "),
      description: "Imported from translation files",
      sourceLanguage: languages.has("en")
        ? "en"
        : (languages.keys().next().value ?? ""),
      languages: [...languages.values()],
      keys: [...keys.values()].sort((a, b) => a.name.localeCompare(b.name)),
      warnings: [...warnings],
    },
    allowExternalReferences,
  );
}
