import { keyNameSchema } from "../validation";
import { writePlural, PLURAL_CATEGORIES } from "../messages";
export type Catalog = Map<string, string>;
export const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
export function add(catalog: Catalog, key: string, value: string) {
  keyNameSchema.parse(key);
  if (catalog.has(key)) throw new Error(`Duplicate translation key: ${key}.`);
  if (value.length > 20000)
    throw new Error(`Translation ${key} exceeds 20,000 characters.`);
  if (catalog.size >= 50000)
    throw new Error("Import up to 50,000 keys per project.");
  catalog.set(key, value);
}
export function flatten(
  value: unknown,
  prefix = "",
  result: Catalog = new Map(),
  depth = 0,
): Catalog {
  if (!isObject(value))
    throw new Error("Expected an object of translation strings.");
  if (depth > 32) throw new Error("Translation nesting exceeds 32 levels.");
  for (const [name, item] of Object.entries(value)) {
    // Validate each segment before flattening, including empty and reserved names.
    keyNameSchema.parse(name);
    const key = prefix ? `${prefix}.${name}` : name;
    if (
      isObject(item) &&
      Object.hasOwn(item, "other") &&
      Object.keys(item).every((form) =>
        PLURAL_CATEGORIES.includes(form as never),
      )
    ) {
      if (Object.values(item).some((text) => typeof text !== "string"))
        throw new Error(`Invalid plural forms for ${key}.`);
      add(
        result,
        key,
        writePlural({
          variable: "count",
          type: "cardinal",
          offset: 0,
          forms: item as Record<string, string>,
        }),
      );
    } else if (isObject(item)) flatten(item, key, result, depth + 1);
    else if (typeof item === "string") add(result, key, item);
    else
      throw new Error(
        `${key}: translation values must be strings, not arrays, numbers or null.`,
      );
  }
  return result;
}
export function nested(catalog: Catalog): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, text] of catalog) {
    keyNameSchema.parse(key);
    const segments = key.split(".");
    let current = result;
    for (const segment of segments.slice(0, -1)) {
      if (typeof current[segment] === "string")
        throw new Error(
          `Nested export collision at ${key}. Use a flat format.`,
        );
      current[segment] ??= Object.create(null);
      current = current[segment] as Record<string, unknown>;
    }
    const last = segments.at(-1)!;
    if (current[last] !== undefined)
      throw new Error(`Nested export collision at ${key}. Use a flat format.`);
    current[last] = text;
  }
  return result;
}
export function canonicalLocale(code: string) {
  const locale = Intl.getCanonicalLocales(code.replaceAll("_", "-"))[0];
  if (!locale) throw new Error("Use a language code such as en or pt-BR.");
  return locale;
}
export function xml(value: string) {
  if (
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u.test(value) ||
    !value.isWellFormed()
  )
    throw new Error(
      "XML export cannot represent a control character or unpaired surrogate in this copy. Use JSON.",
    );
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
    .replaceAll("\r", "&#13;");
}
export function unescapeQuoted(value: string) {
  // Apple strings and keyed gettext use the same restricted C-style escapes.
  return value.replace(
    /\\(U[0-9a-fA-F]{4}|u[0-9a-fA-F]{4}|[\s\S])/g,
    (_, escape: string) => {
      if (/^[uU]/.test(escape))
        return String.fromCharCode(parseInt(escape.slice(1), 16));
      const known: Record<string, string> = {
        n: "\n",
        r: "\r",
        t: "\t",
        b: "\b",
        f: "\f",
        '"': '"',
        "\\": "\\",
      };
      if (!Object.hasOwn(known, escape))
        throw new Error(`Unsupported escape: \\${escape}.`);
      return known[escape]!;
    },
  );
}
