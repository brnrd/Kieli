import type { Project, TranslationKey } from "../shared";
import { advancedKey, looksPlural } from "../messages";

export function canEditInline(
  project: Project,
  key: TranslationKey,
  language: string,
  manager: boolean,
) {
  return (
    !project.archivedAt &&
    project.languages.some(
      (locale) => locale.code === language && !locale.disabled,
    ) &&
    (manager || language !== project.sourceLanguage) &&
    !advancedKey(key) &&
    !Object.values(key.translations).some(looksPlural)
  );
}
export function inlineUpdate(
  key: TranslationKey,
  language: string,
  text: string,
) {
  return {
    version: key.version,
    expectedSourceContext: key.sourceContext,
    translations: { [language]: text },
  };
}
