import {
  parse,
  TYPE,
  type MessageFormatElement,
  type PluralElement,
} from "@formatjs/icu-messageformat-parser";
import type { Locale, Project, TranslationKey } from "./shared";

export const PLURAL_CATEGORIES = [
  "zero",
  "one",
  "two",
  "few",
  "many",
  "other",
] as const;
export type PluralCategory = (typeof PLURAL_CATEGORIES)[number];
export type PluralKind = "cardinal" | "ordinal";
export type PluralMessage = {
  variable: string;
  type: PluralKind;
  offset: number;
  forms: Record<string, string>;
};
export function categories(
  locale: Locale | string,
  type: PluralKind = "cardinal",
): PluralCategory[] {
  if (typeof locale !== "string") {
    const override =
      type === "ordinal" ? locale.ordinalForms : locale.pluralForms;
    if (override) return [...override];
  }
  const code = typeof locale === "string" ? locale : locale.code;
  const forms = new Intl.PluralRules(code, { type }).resolvedOptions()
    .pluralCategories;
  return PLURAL_CATEGORIES.filter((form) => forms.includes(form));
}
export function pluralNodes(text: string): PluralElement[] {
  const result: PluralElement[] = [];
  function visit(nodes: MessageFormatElement[], depth = 0) {
    if (depth > 20) throw new Error("ICU nesting exceeds 20 levels.");
    for (const node of nodes) {
      if (node.type === TYPE.plural) result.push(node);
      if (node.type === TYPE.plural || node.type === TYPE.select)
        for (const option of Object.values(node.options))
          visit(option.value, depth + 1);
    }
  }
  visit(parse(text, { ignoreTag: true, captureLocation: true }));
  return result;
}
export function looksPlural(text: string) {
  return /\{[^{}]+,\s*(?:plural|selectordinal)\s*,/.test(text);
}
export function readPlural(text: string): PluralMessage | undefined {
  if (!text.trim()) return undefined;
  try {
    const ast = parse(text, { ignoreTag: true, captureLocation: true });
    const node = ast[0];
    if (ast.length !== 1 || !node || node.type !== TYPE.plural)
      return undefined;
    return {
      variable: node.value,
      type: node.pluralType ?? "cardinal",
      offset: node.offset,
      forms: Object.fromEntries(
        Object.entries(node.options).map(([form, option]) => [
          form,
          text.slice(
            option.location!.start.offset + 1,
            option.location!.end.offset - 1,
          ),
        ]),
      ),
    };
  } catch {
    return undefined;
  }
}
export function writePlural(message: PluralMessage, validate = true): string {
  if (!message.variable || /[{},\s]/u.test(message.variable))
    throw new Error("Use an identifier such as count for the plural variable.");
  if (!Object.hasOwn(message.forms, "other"))
    throw new Error("A plural message must include other.");
  const selectors = Object.keys(message.forms);
  if (
    selectors.some(
      (form) =>
        !PLURAL_CATEGORIES.includes(form as PluralCategory) &&
        !/^=-?\d+(?:\.\d+)?$/.test(form),
    )
  )
    throw new Error("Invalid plural selector.");
  const text = `{${message.variable}, ${message.type === "ordinal" ? "selectordinal" : "plural"}, ${message.offset ? `offset:${message.offset} ` : ""}${selectors.map((form) => `${form} {${message.forms[form]}}`).join(" ")}}`;
  if (!validate) return text;
  const parsed = readPlural(text);
  if (
    !parsed ||
    parsed.variable !== message.variable ||
    Object.keys(parsed.forms).length !== selectors.length ||
    selectors.some((form) => parsed.forms[form] !== message.forms[form])
  )
    throw new Error(
      "Unbalanced ICU syntax inside a plural form. Quote literal braces with ICU apostrophes.",
    );
  return text;
}
export function emptyPlural(
  locale: Locale,
  variable = "count",
  type: PluralKind = "cardinal",
) {
  return writePlural({
    variable,
    type,
    offset: 0,
    forms: Object.fromEntries(
      categories(locale, type).map((form) => [form, ""]),
    ),
  });
}
export function completeMessage(text: string, locale: Locale, plural = false) {
  if (!text.trim()) return false;
  if (!plural) return true;
  try {
    const nodes = pluralNodes(text);
    return (
      nodes.length > 0 &&
      nodes.every((node) =>
        categories(locale, node.pluralType).every(
          (form) =>
            !!node.options[form]?.value.length &&
            text
              .slice(
                node.options[form]!.location!.start.offset + 1,
                node.options[form]!.location!.end.offset - 1,
              )
              .trim(),
        ),
      )
    );
  } catch {
    return false;
  }
}
export function validatePlural(text: string) {
  if (text.trim() && (!looksPlural(text) || !pluralNodes(text).length))
    throw new Error(
      "Plural keys require a valid ICU plural message or an empty translation.",
    );
}
export const referencePattern = /\[%key:([a-zA-Z0-9_][a-zA-Z0-9_.-]*)%\]/g;
export function references(text: string) {
  return [...text.matchAll(referencePattern)].map((match) => match[1]!);
}
export function advancedKey(
  key: Pick<TranslationKey, "plural" | "translations">,
) {
  return (
    !!key.plural ||
    Object.values(key.translations).some(
      (text) => text.includes("[%key:") || text.includes("[%key_id:"),
    )
  );
}

export function resolveProject(
  keys: TranslationKey[],
  project: Project,
  validateOnly = false,
  validateNames?: Set<string>,
): TranslationKey[] {
  const byName = new Map(keys.map((key) => [key.name, key]));
  const memo = new Map<string, { text: string; error?: string }>();
  const visiting = new Set<string>();
  function resolve(
    name: string,
    locale: string,
    depth: number,
  ): { text: string; error?: string } {
    const id = `${locale}:${name}`;
    const cached = memo.get(id);
    if (cached) return cached;
    if (depth > 20 || visiting.has(id))
      throw new Error(
        `Circular or over-deep reference at ${name} (${locale}).`,
      );
    const key = byName.get(name);
    if (!key)
      throw new Error(`Referenced key ${name} does not exist in this project.`);
    const raw = key.translations[locale] ?? "";
    if (raw.includes("[%key_id:"))
      throw new Error(
        "Use [%key:name%] references. Lokalise IDs must be mapped to names during import.",
      );
    const refs = references(raw);
    if (refs.length > 20)
      throw new Error("Use at most 20 references per translation.");
    if (
      raw.includes("[%key:") &&
      refs.length !== (raw.match(/\[%key:/g)?.length ?? 0)
    )
      throw new Error(`Malformed reference in ${name}. Use [%key:other.key%].`);
    visiting.add(id);
    let error: string | undefined;
    const text = raw.replace(referencePattern, (_, target: string) => {
      const parent = byName.get(target);
      if (!parent)
        throw new Error(
          `Referenced key ${target} does not exist in this project.`,
        );
      if (parent.plural)
        throw new Error(
          `Plural key ${target} cannot be referenced. Reference a plain-text key.`,
        );
      const resolved = resolve(target, locale, depth + 1);
      if (!resolved.text.trim() || resolved.error)
        error = `Missing referenced translation: ${target} (${locale}).`;
      return resolved.text;
    });
    visiting.delete(id);
    if (text.length > 20000)
      throw new Error(
        `Expanded translation ${name} exceeds 20,000 characters.`,
      );
    if (key.plural && text.trim()) validatePlural(text);
    const result = { text, ...(error ? { error } : {}) };
    memo.set(id, result);
    return result;
  }
  return keys.map((key) => {
    if (validateOnly && validateNames && !validateNames.has(key.name))
      return key;
    const resolvedTranslations: Record<string, string> = {},
      referenceErrors: Record<string, string> = {};
    for (const locale of project.languages) {
      try {
        const resolved = resolve(key.name, locale.code, 0);
        resolvedTranslations[locale.code] = resolved.text;
        if (resolved.error) referenceErrors[locale.code] = resolved.error;
      } catch (error) {
        if (validateOnly) throw error;
        visiting.clear();
        resolvedTranslations[locale.code] = "";
        referenceErrors[locale.code] = (error as Error).message;
      }
    }
    return validateOnly
      ? key
      : { ...key, resolvedTranslations, referenceErrors };
  });
}
export function translationComplete(key: TranslationKey, locale: Locale) {
  return (
    !key.outdatedLanguages?.includes(locale.code) &&
    !key.referenceErrors?.[locale.code] &&
    completeMessage(
      key.resolvedTranslations?.[locale.code] ??
        key.translations[locale.code] ??
        "",
      locale,
      !!key.plural,
    )
  );
}

// Add newly required language forms without discarding project-specific forms.
// Fallback is applied per category, using source `other` when categories differ.
export function exportPlural(
  value: string,
  locale: Locale,
  source: string,
  fallback: boolean,
) {
  const target = readPlural(value),
    template = target ?? readPlural(source);
  if (!template) return value;
  const sourceForms = readPlural(source)?.forms ?? {};
  const forms = { ...(target?.forms ?? {}) };
  for (const form of new Set([
    ...categories(locale, template.type),
    ...Object.keys(forms),
  ]))
    if (!forms[form]?.trim())
      forms[form] = fallback
        ? sourceForms[form] || sourceForms.other || ""
        : (forms[form] ?? "");
  return writePlural({ ...template, forms });
}

export function pluralSignature(text: string) {
  return JSON.stringify(
    [
      ...new Set(
        pluralNodes(text).map((node) =>
          JSON.stringify([node.value, node.pluralType, node.offset]),
        ),
      ),
    ].sort(),
  );
}
