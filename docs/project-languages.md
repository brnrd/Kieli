# Disable and re-enable target languages

A project manager can use **Languages → Disable** to pause a target language, then **Enable** to resume work. The source language always remains enabled. Archived projects must be restored before changing languages.

Disabling preserves translations, native Apple plural metadata, plural overrides, history, glossary terms and integration grants. The language remains listed with a **Disabled** label. Its copy leaves ordinary list and modal editing, language filters, completion totals and default exports. Copy reads and history inspection remain available. Source changes still make retained target copy outdated; enabling never marks it current automatically.

No confirmation dialog is required: the action is reversible. Both changes are audited. Settings and copy writes use project-version conditions on SQLite and DynamoDB, so a concurrent disable rejects a pending save. Import previews created before a language change must be previewed again.

## Export and integration behavior

- Browser exports initially select enabled languages. A disabled language can be selected explicitly to retrieve its retained copy.
- API exports without `languages`, or with an empty value, include enabled languages only. An explicit `languages=fr` includes French even when disabled. Unknown codes reject.
- CLI pulls follow the same rule. `--languages fr` and configured language lists count as explicit selections. `--require-current` still checks disabled copy when explicitly requested. Default pulls do not delete old files from the output directory; remove obsolete files yourself when desired.
- Browser/API copy writes, historical translation restoration, import batches and import previews reject disabled languages with HTTP 409. Imports must omit them or a manager must enable them first. Source-only sync continues, retaining disabled targets and their freshness information.
- New MCP connections cannot select disabled targets. Existing connections expose enabled targets within their original grant and cannot write disabled targets. If every permitted target is disabled, listing keys reports an actionable error. Enabling restores that language within an unexpired, unrevoked grant.
- New mobile releases contain enabled languages only. Already published release bundles remain readable, including disabled locales. A newly activated release without that locale has no bundle for it; SDKs use their existing cached/embedded fallback behavior. Disable/enable does not rewrite existing releases.

Terminology remains independently manageable in the glossary. Key lifecycle actions such as renaming (including reference updates), deletion/recovery and full snapshot restoration still operate on the whole key or project. A full snapshot restores captured language settings and all captured copy, including disabled states; it is not a locale-specific edit.

## API

```http
POST /api/projects/web/languages/fr
Content-Type: application/json

{"version": 4, "enabled": false}
```

This requires a signed-in project manager or administrator. Export, source-sync and MCP credentials cannot change settings. Stale project versions reject with 409. The source language cannot be disabled, even through the general settings endpoint.

Project locale objects now accept an optional `disabled: true`; missing/false means enabled. The general settings endpoint preserves the same validation, auditing and version conditions. Removing existing languages remains unsupported.

Counters retain every locale so toggles do not scan or rewrite keys. The derived statistics format is version 3, adding a histogram of outdated locale combinations for exact active-language totals. On the first statistics read, older counters rebuild conditionally from existing key indexes. Copy and immutable history are unchanged. Snapshots continue to capture all languages and their native metadata; no manual data migration is required.

Validated locally with disposable SQLite fixtures, concurrent transaction interception, compiled HTTP endpoints, real CLI pulls and browser checks. These checks do not claim live DynamoDB or AWS verification.
