import { unzipSync, strFromU8 } from "fflate";
import type { Locale } from "./shared";
import { keySchema } from "./validation";
import {
  looksPlural,
  writePlural,
  PLURAL_CATEGORIES,
  references,
  resolveProject,
} from "./messages";
import type { z } from "zod";

export type ImportKey = z.infer<typeof keySchema>;
export type ImportPreview = {
  name: string;
  description: string;
  sourceLanguage: string;
  languages: Locale[];
  keys: ImportKey[];
  warnings: string[];
};
type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject =>
  !!value && typeof value === "object" && !Array.isArray(value);
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_FILE = 10 * 1024 * 1024;
function canonical(code: string) {
  try {
    const locale = Intl.getCanonicalLocales(code.replaceAll("_", "-"))[0];
    if (!locale) throw new Error();
    return locale;
  } catch {
    throw new Error(
      `Invalid language code: ${code}. Rename the language file to a BCP 47 code such as en or pt-BR.`,
    );
  }
}
function languageName(code: string) {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}
function json(text: string, name: string): unknown {
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error(`${name} is not valid JSON.`);
  }
}
function flat(value: unknown, filename: string) {
  if (!object(value))
    throw new Error(`${filename}: expected a JSON object of translation keys.`);
  const result = new Map<string, string>();
  function visit(node: JsonObject, path: string[], depth: number) {
    if (depth > 32)
      throw new Error(`${filename}: JSON nesting exceeds 32 levels.`);
    for (const [name, item] of Object.entries(node)) {
      const segments = [...path, name];
      const key = segments.join(".");
      if (["__proto__", "constructor", "prototype"].includes(name))
        throw new Error(`${filename}: unsafe key segment ${name}.`);
      if (
        object(item) &&
        Object.hasOwn(item, "other") &&
        Object.keys(item).every((form) =>
          PLURAL_CATEGORIES.includes(form as never),
        )
      ) {
        if (Object.values(item).some((text) => typeof text !== "string"))
          throw new Error(`Invalid plural forms for ${key}.`);
        if (result.has(key)) throw new Error(`Duplicate key ${key}.`);
        result.set(
          key,
          writePlural({
            variable: "count",
            type: "cardinal",
            offset: 0,
            forms: item as Record<string, string>,
          }),
        );
      } else if (object(item)) visit(item, segments, depth + 1);
      else {
        if (typeof item !== "string")
          throw new Error(
            `${filename}: ${key} must be a string. Arrays, numbers, and null values are not silently converted.`,
          );
        if (result.has(key))
          throw new Error(
            `${filename}: dotted and nested keys collide at ${key}.`,
          );
        result.set(key, item);
      }
    }
  }
  visit(value, [], 0);
  return result;
}
function validate(preview: ImportPreview) {
  if (!preview.languages.length || preview.languages.length > 30)
    throw new Error("An import must have between 1 and 30 languages.");
  if (!preview.keys.length)
    throw new Error("No translation keys were found in this export.");
  if (preview.keys.length > 50000)
    throw new Error(
      "Import up to 50,000 keys per project. Split this export into smaller projects.",
    );
  const seen = new Set<string>();
  for (const key of preview.keys) {
    const parsed = keySchema.safeParse(key);
    if (!parsed.success)
      throw new Error(
        `Key “${key.name}”: ${parsed.error.issues.map((i) => i.message).join(" ")} Key names must use letters, numbers, dots, hyphens, or underscores.`,
      );
    if (seen.has(key.name))
      throw new Error(
        `Duplicate key name: ${key.name}. No keys will be overwritten.`,
      );
    seen.add(key.name);
    if (new TextEncoder().encode(JSON.stringify(key)).length > 120000)
      throw new Error(
        `Key ${key.name} exceeds the 120 KB import limit. Split long copy into smaller keys.`,
      );
  }
  for (const key of preview.keys) {
    if (
      key.plural === undefined &&
      Object.values(key.translations).some(looksPlural)
    )
      key.plural = true;
    keySchema.parse(key);
  }
  // Validate references across the entire import, then put dependencies first so
  // bounded API batches never introduce references to keys not imported yet.
  resolveProject(
    preview.keys as never,
    { languages: preview.languages } as never,
    true,
  );
  const byName = new Map(preview.keys.map((key) => [key.name, key]));
  const done = new Set<string>();
  const ordered: ImportKey[] = [];
  function visit(key: ImportKey) {
    if (done.has(key.name)) return;
    done.add(key.name);
    for (const name of Object.values(key.translations).flatMap(references)) {
      const target = byName.get(name);
      if (target) visit(target);
    }
    ordered.push(key);
  }
  preview.keys.forEach(visit);
  preview.keys = ordered;
  return preview;
}
export { validate as validateImportPreview };

export function parseBundle(
  files: { name: string; text: string }[],
  projectName = "Imported project",
): ImportPreview {
  const languages = new Map<string, Locale>();
  const keys = new Map<string, ImportKey>();
  const warnings: string[] = [];
  for (const file of files) {
    const basename = file.name
      .split("/")
      .at(-1)!
      .replace(/\.json$/i, "");
    const code = canonical(basename);
    if (languages.has(code))
      throw new Error(
        `More than one file maps to ${code}. Export one file per language from Lokalise.`,
      );
    if (code !== basename)
      warnings.push(`Language code ${basename} will be normalized to ${code}.`);
    languages.set(code, { code, name: languageName(code) });
    for (const [name, text] of flat(json(file.text, file.name), file.name)) {
      const key = keys.get(name) ?? {
        name,
        namespace: name.includes(".") ? name.split(".")[0]! : "general",
        description: "",
        tags: [],
        translations: {},
      };
      key.translations[code] = text;
      keys.set(name, key);
    }
  }
  const locales = [...languages.values()];
  return validate({
    name: projectName,
    description: "Imported from Lokalise",
    sourceLanguage: locales.some((l) => l.code === "en")
      ? "en"
      : (locales[0]?.code ?? ""),
    languages: locales,
    keys: [...keys.values()].sort((a, b) => a.name.localeCompare(b.name)),
    warnings,
  });
}

export function parseSnapshot(input: unknown, platform = "web"): ImportPreview {
  if (
    !object(input) ||
    !Array.isArray(input.keys) ||
    !Array.isArray(input.languages)
  )
    throw new Error(
      "An API snapshot must contain project, languages, and keys. For downloaded translations, use a JSON ZIP with one file per language.",
    );
  const project = object(input.project) ? input.project : {};
  const warnings: string[] = [];
  const locales = new Map<string, Locale>();
  for (const raw of input.languages) {
    if (
      !object(raw) ||
      (typeof raw.lang_iso !== "string" && typeof raw.language_iso !== "string")
    )
      throw new Error(
        "Snapshot language entries must have lang_iso or language_iso.",
      );
    const original = String(raw.lang_iso ?? raw.language_iso);
    const code = canonical(original);
    if (locales.has(code))
      throw new Error(`Duplicate normalized language: ${code}.`);
    if (code !== original)
      warnings.push(`${original} will be normalized to ${code}.`);
    locales.set(code, {
      code,
      name: String(raw.lang_name ?? raw.language_name ?? languageName(code)),
    });
  }
  const keys: ImportKey[] = [];
  let excluded = 0;
  const ids = new Map<string, string>();
  for (const raw of input.keys) {
    if (!object(raw)) continue;
    const name =
      typeof raw.key_name === "string"
        ? raw.key_name
        : object(raw.key_name)
          ? raw.key_name[platform]
          : undefined;
    if (typeof name === "string" && name && raw.key_id !== undefined)
      ids.set(String(raw.key_id), name);
  }
  for (const raw of input.keys) {
    if (!object(raw)) throw new Error("Invalid key in API snapshot.");
    const name =
      typeof raw.key_name === "string"
        ? raw.key_name
        : object(raw.key_name)
          ? raw.key_name[platform]
          : undefined;
    if (typeof name !== "string" || !name) {
      excluded++;
      continue;
    }
    if (!Array.isArray(raw.translations))
      throw new Error(
        `Key ${name} has no translations array. Export with include_translations=1.`,
      );
    const plural =
      raw.is_plural === true ||
      raw.translations.some((t) => object(t) && object(t.translation));
    const translations: Record<string, string> = {};
    for (const item of raw.translations) {
      if (!object(item) || typeof item.language_iso !== "string")
        throw new Error(`Invalid translation in ${name}.`);
      const code = canonical(item.language_iso);
      if (!locales.has(code))
        throw new Error(
          `Key ${name} uses ${code}, which is absent from the language list.`,
        );
      if (Object.hasOwn(translations, code))
        throw new Error(`Duplicate ${code} translation for ${name}.`);
      const text = item.translation;
      if (typeof text === "string") {
        if (plural && text.trim())
          throw new Error(
            `Key ${name} mixes plural objects with nonempty strings.`,
          );
        translations[code] = text;
      } else if (
        object(text) &&
        plural &&
        Object.values(text).every((value) => typeof value === "string")
      ) {
        translations[code] = writePlural({
          variable: "count",
          type: "cardinal",
          offset: 0,
          forms: text as Record<string, string>,
        });
      } else throw new Error(`Unsupported translation value in ${name}.`);
      translations[code] = translations[code]!.replace(
        /\[%key_id:(\d+)%\]/g,
        (_, id: string) => {
          const target = ids.get(id);
          if (!target)
            throw new Error(
              `Reference ${id} has no ${platform} key name in this export.`,
            );
          return `[%key:${target}%]`;
        },
      );
    }
    keys.push({
      name,
      namespace: name.includes(".") ? name.split(".")[0]! : "general",
      description: typeof raw.description === "string" ? raw.description : "",
      tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
      translations,
      ...(plural ? { plural: true } : {}),
    });
  }
  if (excluded)
    warnings.push(
      `${excluded} keys without a ${platform} key name are excluded. Select another platform to import those keys.`,
    );
  const sourceLanguage = canonical(
    String(project.base_language_iso ?? locales.keys().next().value ?? "en"),
  );
  if (!locales.has(sourceLanguage))
    throw new Error(
      "The source language is absent from the snapshot language list.",
    );
  return validate({
    name: String(project.name ?? "Imported project"),
    description: String(project.description ?? "Imported from Lokalise"),
    sourceLanguage,
    languages: [...locales.values()],
    keys,
    warnings,
  });
}

export function parseLokalise(
  bytes: Uint8Array,
  filename: string,
  platform = "web",
): ImportPreview {
  if (bytes.length > MAX_FILE)
    throw new Error("Choose an export smaller than 10 MB compressed.");
  if (/\.zip$/i.test(filename)) {
    let total = 0;
    let count = 0;
    let ignored = 0;
    let archive;
    try {
      archive = unzipSync(bytes, {
        filter: (entry) => {
          if (++count > 1000)
            throw new Error("Archive contains too many files.");
          if (
            entry.name.includes("..") ||
            entry.name.startsWith("/") ||
            entry.name.includes("\\")
          )
            throw new Error("Unsafe path in ZIP archive.");
          if (
            entry.name.startsWith("__MACOSX/") ||
            !entry.name.toLowerCase().endsWith(".json")
          ) {
            ignored++;
            return false;
          }
          total += entry.originalSize;
          if (entry.originalSize > MAX_FILE || total > MAX_BYTES)
            throw new Error("Uncompressed export exceeds the 25 MB limit.");
          return true;
        },
      });
    } catch (error) {
      throw new Error(`Unable to read ZIP: ${(error as Error).message}`);
    }
    const files = Object.entries(archive).map(([name, data]) => ({
      name,
      text: strFromU8(data),
    }));
    if (!files.length)
      throw new Error(
        "No language JSON files found. Export JSON with one file per language from Lokalise.",
      );
    const preview = parseBundle(
      files,
      filename.replace(/\.zip$/i, "").replace(/[-_]/g, " "),
    );
    if (ignored)
      preview.warnings.push(
        `${ignored} non-translation files or folders ignored. Only language JSON files are imported.`,
      );
    return preview;
  }
  if (!/\.json$/i.test(filename))
    throw new Error("Choose a .zip export or .json API snapshot.");
  const data = json(strFromU8(bytes), filename);
  if (object(data) && Array.isArray(data.keys))
    return parseSnapshot(data, platform);
  if (object(data) && object(data.translations))
    return parseBundle(
      Object.entries(data.translations).map(([code, values]) => ({
        name: `${code}.json`,
        text: JSON.stringify(values),
      })),
    );
  return parseBundle([{ name: filename, text: strFromU8(bytes) }]);
}
