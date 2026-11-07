# Next essentials

The first essentials pass is implemented: translation freshness, per-key history and recoverable deletion, previewed updates into existing projects, source-only CLI/CI sync, and shared argument validation with a strict export gate. Contributor guidance and GitHub issue/PR templates are also in place.

Continue one feature at a time, verify it, and commit it before starting the next. The completed item records shipped capabilities; the remaining items are plans.

## 1. Editor navigation and efficiency — completed

Implemented with cursor-based previous/next, next needing attention, Save & next, focus-language filters, guarded drafts, keyboard shortcuts and browser preferences. See [editor navigation](editor-navigation.md). Verified locally with a 3,001-key, six-language fixture and RTL copy.

Original scope: Make working through thousands of keys practical without adding a workflow layer.

- Add previous/next key and next-needs-attention actions that retain the active search, namespace, locale and status filters across database pages.
- Add discoverable keyboard shortcuts, with no interference while typing in inputs or plural editors. Preserve focus and unsaved-change protection.
- Persist useful personal filters locally; keep project data and credentials out of those preferences.
- Check narrow screens, many languages, RTL text and keyboard-only use with a synthetic project of several thousand keys.

Acceptance: a translator can open a filtered result, save a target, move to the next matching key across a page boundary and return to the same list position without losing edits. Concurrent changes and an empty remaining result have clear behavior. Authorization stays in existing services; no additional infrastructure.

## 2. Shared glossary — completed

Implemented project-scoped source and target terms, notes, case sensitivity, searchable terminology beside the editor, previewed add-only JSON import/export and audited manager changes. MCP can read terminology within its existing project/language grant. See [shared glossary](glossary.md) for matching, limits and separate backup requirements.

Acceptance: terms are searchable, safely importable/exportable, audited and protected by project roles. MCP reads terms only within its project scope. Existing translation publication remains independent of any approval process.

## 3. Manual reuse of previous translations — completed

Implemented exact-source suggestions from project history, with historical key/version provenance, per-target lookup, draft replacement confirmation and normal save validation. New writes index history atomically; managers can resumably include older history. Deleted/recreated identities, project scopes and active snapshot datasets are checked. See [manual translation reuse](translation-memory.md) for retention and matching limits.

Acceptance: suggestions show their origin, never cross project/access boundaries and never overwrite copy automatically. Retention/deletion behavior is documented. Avoid an external search service until measured needs justify one.

## 4. Native format fidelity — Apple plurals completed

The first adapter is [Apple `.stringsdict`](apple-stringsdict.md): a bounded single-variable cardinal subset, preserved d/ld/lld metadata, paired plain/native exports, safe CLI downloads and independent golden fixtures. Verified with the compiled HTTP service, real CLI and macOS Foundation rendering. Xcode catalogs, ARB metadata and native gettext plurals remain future candidates; choose the next one from a consuming application and specify its subset before implementing it.

Acceptance: synthetic golden fixtures preserve arguments, plural semantics and supported metadata; unsupported structures produce actionable errors. Import, export, CLI and mobile expectations are documented separately.

## Next: everyday project and key management

Prioritize these product basics before more format adapters or staging tooling. Implement and verify one at a time; items without a completed label are plans, not shipped behavior.

1. **Rename a key — completed.** Signed-in managers can preview and rename keys while preserving identity, translations, native metadata, freshness and history. Exact references and dependent freshness records update atomically; collisions, stale previews and oversized transactions reject without partial writes. Historical previous-translation suggestions follow the stable identity. Application code and source-sync files still require developer changes. See [key renaming](key-renaming.md).
2. **Archive and restore projects — completed.** Managers can archive projects from settings, find them through the directory status filter and restore them. Archived projects are read-only, leave default navigation, and retain copy, settings, history, memberships, exports and published mobile delivery. Concurrent writes are version fenced. See [project archiving](project-archive.md).
3. **Disable and re-enable target languages — completed.** Managers can pause targets while retaining copy, native metadata, history and freshness. Editing, completion, default exports and new mobile releases use enabled languages; explicit API/CLI exports retain disabled-copy access. Server guards and project-version conditions cover saves/imports and MCP. The source stays enabled. See [project languages](project-languages.md).
4. **Bulk metadata changes — completed.** Signed-in managers can preview tag additions/removals and namespace replacement for up to 100 selected keys. Bounded atomic batches retain copy/freshness and update history, search, counters, memory and audit events together. Durable progress, repeat-safe offsets and remaining-key previews handle interruptions and conflicts. See [bulk metadata](bulk-metadata.md).
5. **Duplicate a key — completed.** Create a new named identity with selected context and optional target copy. Independent identity/history, freshness preservation, server validation and concurrent-change guards are implemented. See [key duplication](key-duplication.md).
6. **Export a useful subset — next.** Export selected keys or a namespace instead of requiring a whole-project download. Keep browser, API and CLI selection rules consistent; apply the existing authorization, freshness gate and filename/format safeguards.

Project deletion and permanent language removal stay separate from these recoverable operations. Do not turn archive/disable actions into hidden deletion.

## Release verification — deferred until a staging environment is available

Before an enterprise production rollout, run real IdP lifecycle/mapping checks, AWS installation and backup restoration in a staging account, and cold/warm workload tests using expected project sizes. Local fixtures do not establish those external integrations or operating limits.

Keep screenshot features, translation approvals, built-in automatic translation, SaaS tenancy and broad branching/merging outside this plan unless the product scope changes explicitly.
