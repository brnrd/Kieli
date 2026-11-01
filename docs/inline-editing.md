# Inline translation editing

Click a plain translation in the project list to edit that locale in place. One inline editor is open at a time. Source copy and key context remain visible with the draft. Target editors show the source above the input so you do not need to scroll between languages to check wording.

- **Save** or **Ctrl/Cmd + Enter** saves only that locale. Enter by itself inserts a line break.
- **Cancel** or **Escape** discards the inline draft and returns focus to the original value.
- Clicking elsewhere does not save or discard the draft. **Unsaved** remains visible until you save or cancel.
- Changing filters, pages, projects, tabs, or the editing cell asks before discarding a changed draft. Hiding the editing locale and browser back/forward use the same guard. Reload/tab close uses the browser's native warning when supported.
- **Full editor**, the key name, or the pencil action opens metadata, terminology, previous translations and history. Save first if you want to retain an inline draft; otherwise confirm discarding it when prompted.
- Press **/** outside text fields to focus list search. This shortcut is inactive during inline editing or an open dialog.

Plurals and linked keys use the full editor. Project users can edit target languages; source edits require a manager. Archived projects remain read-only. These browser affordances supplement the existing backend authorization checks.

## Save behavior

Inline editing uses the normal version-checked key endpoint and source-context checks. Only the selected locale is submitted; metadata and other translations remain unchanged. Placeholder validation, history, freshness and archive restrictions apply as for the full editor. Changing source copy marks unchanged target translations outdated.

An unchanged value does not create a new write. For an outdated translation, explicitly select **This translation matches the current source** to retain and mark that wording current, or change the text before saving. No copy is certified merely by opening the editor.

A failed save retains the draft with its error. A concurrent key edit, including one in a different locale, causes a conflict rather than overwriting it. **Load latest version** asks before discarding the draft, then loads the latest key. Nothing is retried automatically. Drafts are held in memory only; they are not stored in local storage or restored after a browser crash.

## Information hierarchy

Translation copy uses larger, higher-contrast text than locale labels and metadata. The active row and editor are highlighted, with status and save actions beside the draft. Source and context are shown where the edit happens. Missing and outdated badges remain visible; repeated Current badges and the default `general` namespace label are omitted to reduce list noise. Non-default namespaces and tags remain visible, and all metadata remains available in the full editor. The pencil action has an explicit accessible label; the key column no longer displays an inactive sort icon.

Local browser checks cover explicit and keyboard saves, blur, Escape, placeholder errors, concurrent edits, reload confirmation, filtered/paginated navigation, and plural/reference fallbacks. Unit/service tests cover the one-locale payload and normal authorization/concurrency boundaries. Live browser/IdP/AWS integration verification remains separate.
