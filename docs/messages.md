# Plurals and linked copy

Keys keep `translations: Record<locale, string>` for API compatibility. A plural key additionally has `plural: true`; its non-empty translations are ICU MessageFormat strings. Existing plain-string projects need no data conversion. The editor automatically prepares each language's Unicode cardinal forms, including all six Arabic categories, and supports ordinals, exact selectors, offsets and nested ICU through raw mode. The form editor handles a single top-level plural; complex messages stay in raw mode. Example:

```text
{count, plural, one {One item} other {# items}}
```

Required categories follow `Intl.PluralRules` in the application runtime. Managers can override cardinal and ordinal categories project-wide under **Plural forms per language**. `other` is mandatory. Extra existing forms are retained when settings change; the editor labels them as additional forms. Completion requires every configured form to contain copy. Whitespace-only and missing forms remain incomplete. Adding a language or changing the required categories affects completion immediately. A plural key can retain an empty target translation until translated; the editor/export prepares its language forms without inventing translated text.

Lokalise API snapshot plural objects and JSON/YAML category-only objects (`{one: "…", other: "…"}`) import as one ICU plural key, using `count` as the variable. Objects with additional keys are normal nested objects. If your application has ordinary nested keys named `one`/`other`, use explicitly dotted flat keys to avoid this convention. ICU messages also import as plural keys automatically when no explicit `plural` flag is supplied. Mixed nonempty plain/ICU translations in one plural key are rejected. Android `<plurals>` import/export handles cardinal forms and count `%d`/`%1$d`; complex ICU cannot silently flatten into native Android resources. Other keyed formats preserve ICU as string values; they do not imply native platform plural resources. Native gettext plural entries and Apple `.stringsdict` are not implemented.

Exports prepare missing categories. With source fallback enabled, each missing target category uses the same source category or source `other`; it remains the consuming application's responsibility to format ICU. Flat/nested JSON and ARB are useful ICU interchange formats. File exports do not turn ICU into already-selected singular/plural copy.

Claude Code MCP reads raw and resolved source context and the project's required categories. It can fill missing plural forms while preserving populated forms. Changes to populated forms require an overwrite-enabled credential and `overwriteExisting: true`. MCP cannot change the variable, cardinal/ordinal rule or offset. A new target message inherits those constraints from source. Regular translators also cannot change a simple plural's variable/type/offset.

## References

Use a same-project key name inside a translation:

```text
Welcome to [%key:product.name%].
```

References can appear inline, multiple times or through other keys. The editor keeps the raw placeholder and shows resolved copy in the key list; exports and OTA publication resolve current values. A target key change therefore needs no duplicate edits. Missing target-language copy remains incomplete and blocks export of that language rather than substituting the wrong language silently. Missing keys, cycles, malformed placeholders, references to plural keys, more than 20 references per translation, depth over 20 and expanded text over 20,000 characters are rejected on writes. You must remove inbound references before deleting their target. Legacy invalid references are shown as repairable errors when read. There are no cross-project references.

Lokalise API imports map `[%key_id:123%]` to the selected platform's key name. A missing/excluded ID fails import preview. Preview validates the complete graph and orders dependencies first so API import batches remain valid. Reference resolution never evaluates template code.

## Scale

Ordinary projects retain database cursor pagination and indexed filtering. Plural/reference projects build a derived view for accurate completion, linked-copy search and filters. The first read of a project revision loads its keys; warm views are keyed by project/settings/stat versions, expire after 30 seconds and share a 20 MiB cache budget per store/process. Writes to these projects validate the whole reference graph and use a conditional project/stat guard. This favors correctness and a small maintainable backend for thousands of keys; it is not an indexed dependency engine for arbitrarily large projects. Keep projects bounded and measure cold DynamoDB reads for your expected workload.
