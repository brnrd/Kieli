import { createHash } from "node:crypto";
import type { Project, TranslationKey } from "../shared";
import { references, translationComplete } from "../messages";
export type SourceContext = { token: string; baseline: boolean };
export function sourceContexts(keys: TranslationKey[], project: Project) {
  const byName = new Map(keys.map((key) => [key.name, key])),
    memo = new Map<string, SourceContext>(),
    visiting = new Set<string>();
  function context(name: string, depth = 0): SourceContext {
    const cached = memo.get(name);
    if (cached) return cached;
    const key = byName.get(name);
    if (!key || visiting.has(name) || depth > 20)
      return { token: "invalid", baseline: false };
    visiting.add(name);
    const dependencies = references(
      key.translations[project.sourceLanguage] ?? "",
    ).map((name) => context(name, depth + 1));
    const revision = key.sourceRevision ?? 1;
    const result = {
      token: createHash("sha256")
        .update(
          JSON.stringify([
            revision,
            !!key.plural,
            key.translations[project.sourceLanguage] ?? "",
            dependencies.map((item) => item.token),
          ]),
        )
        .digest("hex"),
      baseline: revision === 1 && dependencies.every((item) => item.baseline),
    };
    visiting.delete(name);
    memo.set(name, result);
    return result;
  }
  for (const key of keys) context(key.name);
  return memo;
}
export function freshnessView(
  keys: TranslationKey[],
  project: Project,
): TranslationKey[] {
  const contexts = sourceContexts(keys, project);
  return keys.map((key) => {
    const context = contexts.get(key.name)!;
    return {
      ...key,
      sourceContext: context.token,
      outdatedLanguages: project.languages
        .filter(
          (locale) =>
            locale.code !== project.sourceLanguage &&
            !!key.translations[locale.code]?.trim() &&
            (key.translationSources?.[locale.code]
              ? key.translationSources[locale.code] !== context.token
              : !context.baseline),
        )
        .map((locale) => locale.code),
    };
  });
}
export function stampFreshness(
  previous: TranslationKey | undefined,
  next: TranslationKey,
  project: Project,
  context: SourceContext,
  before: SourceContext | undefined,
  touched: string[],
) {
  const translationSources = { ...previous?.translationSources };
  // Legacy values are current against the original source only; never bless a changed dependency.
  if (previous && before?.baseline)
    for (const [code, text] of Object.entries(previous.translations))
      if (text.trim() && !translationSources[code])
        translationSources[code] = before.token;
  const sourceChanged =
    !!previous &&
    (previous.translations[project.sourceLanguage] !==
      next.translations[project.sourceLanguage] ||
      !!previous.plural !== !!next.plural);
  for (const code of touched) {
    if (!next.translations[code]?.trim()) delete translationSources[code];
    else if (
      code === project.sourceLanguage ||
      !sourceChanged ||
      next.translations[code] !== previous?.translations[code]
    )
      translationSources[code] = context.token;
  }
  translationSources[project.sourceLanguage] = context.token;
  return { ...next, translationSources };
}
export function translationStatus(
  key: TranslationKey,
  locale: Project["languages"][number],
) {
  if (key.outdatedLanguages?.includes(locale.code)) return "outdated";
  return translationComplete(key, locale) ? "current" : "missing";
}
