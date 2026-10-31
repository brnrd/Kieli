# Next essentials

The first essentials pass is implemented: translation freshness, per-key history and recoverable deletion, previewed updates into existing projects, source-only CLI/CI sync, and shared argument validation with a strict export gate. Contributor guidance and GitHub issue/PR templates are also in place.

Continue one feature at a time, verify it, and commit it before starting the next. The items below are plans, not shipped capabilities.

## 1. Editor navigation and efficiency

Start here. Make working through thousands of keys practical without adding a workflow layer.

- Add previous/next key and next-needs-attention actions that retain the active search, namespace, locale and status filters across database pages.
- Add discoverable keyboard shortcuts, with no interference while typing in inputs or plural editors. Preserve focus and unsaved-change protection.
- Persist useful personal filters locally; keep project data and credentials out of those preferences.
- Check narrow screens, many languages, RTL text and keyboard-only use with a synthetic project of several thousand keys.

Acceptance: a translator can open a filtered result, save a target, move to the next matching key across a page boundary and return to the same list position without losing edits. Concurrent changes and an empty remaining result have clear behavior. Authorization stays in existing services; no additional infrastructure.

## 2. Shared glossary

After editor navigation, add project-scoped terms with source term, target terms, notes and optional case sensitivity. Managers maintain terms; translators can consult them next to copy. Start with manual lookup and deterministic matching, not blocking terminology enforcement.

Acceptance: terms are searchable, safely importable/exportable, audited and protected by project roles. MCP reads terms only within its project scope. Existing translation publication remains independent of any approval process.

## 3. Manual reuse of previous translations

Use existing history as a starting point for project-scoped translation-memory suggestions. Begin with exact source matches; measure whether fuzzy matching is useful before adding it. Suggestions are explicitly applied by a translator and pass the same placeholder/version checks as typed copy.

Acceptance: suggestions show their origin, never cross project/access boundaries and never overwrite copy automatically. Retention/deletion behavior is documented. Avoid an external search service until measured needs justify one.

## 4. Native format fidelity

Choose the next format from a real consuming application rather than expanding a checklist. Candidates are Apple `.stringsdict`/`.xcstrings`, ARB metadata and native gettext plural entries. Specify the supported subset and lossless round-trip fixtures before implementing each adapter.

Acceptance: synthetic golden fixtures preserve arguments, plural semantics and supported metadata; unsupported structures produce actionable errors. Import, export, CLI and mobile expectations are documented separately.

## Release verification

Before an enterprise production rollout, run real IdP lifecycle/mapping checks, AWS installation and backup restoration in a staging account, and cold/warm workload tests using expected project sizes. Local fixtures do not establish those external integrations or operating limits.

Keep screenshot features, translation approvals, built-in automatic translation, SaaS tenancy and broad branching/merging outside this plan unless the product scope changes explicitly.
