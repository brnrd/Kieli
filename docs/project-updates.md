# Updating an existing project

Managers use **Update from files** in a project's header. Choose a supported localization file or ZIP, then **Preview changes**. Single files can use a locale filename (`en.json`, `fr.strings`) or an explicit language hint. Unknown languages must be added to project settings first. New keys require source copy; a target-only file can update known keys.

The file is parsed in a browser worker with the existing size/format limits. Server previews show new, updated and unchanged keys, preserved target values and before/after text. Existing key context, tags and namespaces are retained; new keys use the imported metadata. Apple native integer-format changes are also previewed: source metadata can update, while populated target metadata is kept unless overwrite is selected. Keys absent from a file are never deleted. Empty supplied values never clear stored copy.

Choose an explicit policy:

- **Update source and fill missing targets** (default): update supplied source text, fill empty targets, preserve existing non-empty targets. Source edits mark unchanged targets outdated. Importing the same old target again does not certify it for a changed source.
- **Update source only**: ignore supplied target values.
- **Replace supplied target translations too**: allow non-empty target replacements. An explicitly supplied identical outdated target is accepted for the current source.

Inspect changes, acknowledge applicable format conversion warnings, then apply. Each preview covers up to 20 keys within request/transaction size limits; the browser splits oversized batches further. Each batch is atomic, including key versions, counters, history and its durable receipt. The entire multi-batch update is not one atomic transaction.

Previews are bound to the authenticated identity, auth mode, project version and affected key/source versions. They expire after 24 hours. Reapplying a successful preview returns its stored receipt without making another edit. After a network error, retry the same open dialog. If someone changed affected copy/settings, apply returns 409; inspect a fresh preview before proceeding. Earlier successful batches remain saved. Re-uploading a file creates a new preview; unchanged values are skipped.

References outside a preview batch are flagged and validated again on apply. Dependency-first file ordering lets earlier batches create referenced keys. If an earlier source update changes a later batch's linked source context, that later batch stops with a conflict; preview the remaining content again. Missing references and cycles cannot commit. The browser may parse partial files containing references to existing project keys; new-project import still requires a self-contained reference graph.

Preview staging records contain copy and expire through the configured storage TTL process. They do not change live translations or automatically publish a delivery release. Normal editing roles and origin checks apply. Translation history records applied changes with `import` origin.

API:

```text
POST /api/projects/:id/updates/preview
{ "policy": "merge" | "source" | "overwrite", "keys": [ ...key inputs ] }

POST /api/projects/:id/updates/:previewId/apply
```

The preview response contains its ID, counts, entries, expiry and unresolved reference names. These browser endpoints initially require a signed-in manager; export and MCP credentials cannot invoke them. [Dedicated source-sync credentials and CLI push](source-sync.md) use the same update service with their own restricted boundary.
