export type EditorPreferences = {
  status: "all" | "missing" | "outdated" | "incomplete" | "complete";
  language: string;
  pageSize: 25 | 50 | 100;
};
export const editorDefaults: EditorPreferences = {
  status: "all",
  language: "all",
  pageSize: 50,
};
export const editorPreferenceKey = "kieli.editor.preferences.v1";
// Whitelist enum/locale/display choices only. No search, namespace, project ID,
// translation text or credentials may be persisted here.
export function parseEditorPreferences(value: unknown): EditorPreferences {
  const data =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  let language = "all";
  if (typeof data.language === "string" && data.language.length <= 35)
    try {
      if (Intl.getCanonicalLocales(data.language)[0] === data.language)
        language = data.language;
    } catch {
      /* Ignore malformed stored preferences. */
    }
  return {
    status: ["all", "missing", "outdated", "incomplete", "complete"].includes(
      String(data.status),
    )
      ? (data.status as EditorPreferences["status"])
      : "all",
    language,
    pageSize: [25, 50, 100].includes(Number(data.pageSize))
      ? (Number(data.pageSize) as EditorPreferences["pageSize"])
      : 50,
  };
}
export function isTypingTarget(target: EventTarget | null) {
  return (
    target instanceof Element &&
    !!target.closest(
      "input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox']",
    )
  );
}
