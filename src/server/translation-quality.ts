import type { Project, TranslationKey } from "../shared";
import { completeMessage } from "../messages";
import { HttpError } from "./errors";
import { validatePlaceholders } from "./placeholder-validation";

// Validate runtime argument contracts after resolving linked copy. Locale-specific
// references may differ, but the arguments required by the application must agree.
export function validateKeyQuality(
  key: TranslationKey,
  project: Project,
  touched: string[],
  previous?: Pick<TranslationKey, "translations" | "plural">,
) {
  const source = project.sourceLanguage;
  const values = key.resolvedTranslations ?? key.translations;
  const sourceChanged =
    !previous ||
    previous.translations[source] !== key.translations[source] ||
    !!previous.plural !== !!key.plural;
  const check = (code: string, target: string) => {
    try {
      validatePlaceholders(values[source] ?? "", target);
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      throw new HttpError(
        error.status,
        `${key.name} (${code}): ${error.message}`,
      );
    }
  };
  if (sourceChanged && !key.referenceErrors?.[source])
    check(source, values[source] ?? "");
  for (const locale of project.languages) {
    const code = locale.code;
    if (
      code === source ||
      !touched.includes(code) ||
      key.outdatedLanguages?.includes(code) ||
      key.referenceErrors?.[source] ||
      key.referenceErrors?.[code] ||
      (sourceChanged &&
        previous &&
        key.translations[code] === previous.translations[code]) ||
      !completeMessage(values[code] ?? "", locale, !!key.plural)
    )
      continue;
    check(code, values[code] ?? "");
  }
}
export function requireCurrentCopy(
  keys: TranslationKey[],
  project: Project,
  locales: string[],
) {
  for (const key of keys) {
    for (const code of locales) {
      const locale = project.languages.find((item) => item.code === code)!;
      const text = (key.resolvedTranslations ?? key.translations)[code] ?? "";
      if (
        key.outdatedLanguages?.includes(code) ||
        key.referenceErrors?.[code] ||
        !completeMessage(text, locale, !!key.plural)
      )
        throw new HttpError(
          422,
          `${key.name} (${code}): current, complete copy is required. Fix missing or outdated translations before exporting.`,
        );
    }
    // Also check legacy/restored copy; a freshness anchor alone is not quality validation.
    try {
      validateKeyQuality({ ...key, outdatedLanguages: [] }, project, locales);
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      throw new HttpError(422, error.message);
    }
  }
}
