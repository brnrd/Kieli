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

## Translation freshness

Keys track a monotonic source revision and the source-context fingerprint accepted by each target language. Non-empty translations are **Current** or **Outdated**; absent/incomplete messages remain missing. Source copy and plural-type changes retain existing target text but mark unchanged translations outdated. Editing context, tags or namespaces does not refresh translations. Resaving an explicit target translation accepts the current source, including unchanged text when the editor's **Use this translation for the current source** option is selected. Save source edits before confirming unchanged targets.

Linked source dependencies participate in the fingerprint, so editing a referenced source also makes dependent translations outdated. Browser edits send `expectedSourceContext` alongside the key version; clients editing keys with linked source copy must include the token from the latest key read. A dependency changing concurrently causes 409. MCP exposes this token and outdated locales, and includes outdated copy in its default needs-attention listing; replacement permissions still apply.

Existing values without freshness metadata are treated as current against their original source. Later changes invalidate them conservatively. Snapshot captures/restores retain freshness metadata. Completion counts exclude outdated copy, and OTA publication requires current translations. Ordinary file exports retain outdated text for compatibility. Use `requireCurrent=true` on the export API or `--require-current` on CLI pull to reject missing, outdated or invalid copy before a build; source fallback cannot bypass this gate. Key filters accept `missing`, `outdated`, `complete` and `incomplete` (needs attention). Plain-key projects retain database pagination and transactional counters; reference/plural projects use their existing derived view.

## Shared argument validation

Browser/API saves, new-project imports, existing-project preview/apply, CLI source pushes and MCP share server-side argument checks. Supported contracts include ICU argument names/types/styles/selectors, exact plural selectors and `#`, mustache `{{name}}`, `${name}`, `%{name}`, positional printf types/length modifiers and exact formatting tags. Argument order can change. Linked copy is resolved before comparison, so locale-specific reference placement is allowed when the resulting runtime arguments agree. Reference graph validation remains separate.

New or edited source copy must parse. Non-empty complete target translations being saved or explicitly accepted must preserve the source contract. Errors identify the key and locale and reject the whole write batch. Source-only changes preserve existing targets as outdated; metadata edits do not certify them. Empty targets and partial plural drafts remain editable. Restoring historical text keeps its historical freshness anchor; recovery does not certify old copy for new source text.

No data migration is required. Existing stored text is not rewritten or scanned on startup. It is checked when explicitly saved/accepted, on strict export, and before OTA publication. Strict export validates only requested locales, uses no fallback to satisfy completion, and returns HTTP 422 on quality/freshness failure. CLI pull exits nonzero before writing files if the export fails. Configure `"requireCurrent": true` inside `.keylo.json`'s `pull` section to make this your repository default.

This is deterministic syntax/argument validation, not a translation-quality score, sanitizer or a guarantee for every custom application grammar. Keylo never executes copy. Literal ICU braces/apostrophes must use ICU escaping. New unsupported source syntax must be corrected before saving; custom placeholder dialects need an explicit adapter rather than silently disabling checks. Missing/partial drafts may still contain argument differences until completed, so use strict export or OTA publication as the release boundary.
