# Translation history and deleted keys

Open a key's editor and expand **Translation history**. Choose a language to compare before/after text, actor, time and origin. History is paginated, newest key versions first. It starts when this feature is installed; earlier changes cannot be reconstructed from the current value.

Regular browser saves, imports, MCP writes and individual restores append an immutable history entry in the same transaction as the key and counters. A failed or conflicting write creates no entry. A stable internal key ID keeps different keys with the same reused name separate. Metadata-only edits are also recorded. Project-wide snapshot restoration remains a separate operation recorded in the project security audit; its snapshot/safety backup is the record of that operation, rather than synthesizing individual edit events for every key.

**Restore previous text** or **Restore this version** changes only the selected language. The confirmation shows the text and warns that the editor will close, discarding unsaved drafts. The current key version/source context guards the restore; concurrent changes require reloading. Restoring historical target text keeps its historical source anchor, so older copy can remain outdated. Project users can restore target translations; restoring source copy requires a manager. MCP and export credentials cannot read or restore browser history.

Deleting a key moves its copy and metadata into **Settings → Deleted keys** for 30 days. Managers can restore it while its dependencies and languages remain valid. Restoration preserves its internal identity and freshness, cannot overwrite an occupied name, and uses a newer key version so old editors cannot modify a recreated/restored key. Linked keys must be unlinked before deletion. Before this feature was installed, deleted keys were not retained in trash.

Trash expiry is checked synchronously. DynamoDB TTL removes expired trash eventually; SQLite removes expired TTL records when the store opens. History records are retained without automatic expiry. Translation history contains copy and contributor identifiers; apply your organization's database access, backup, retention and privacy policy. Project snapshots, live delivery releases and security audit records have separate lifecycles.

[Previous translations](translation-memory.md) provides manual exact-source reuse across active keys in this project. It uses a compact derived lookup index; older history can be included by a manager. Deleted identities are excluded even while their history remains retained.

API:

- `GET /api/projects/:project/keys/:key/history?cursor=...`: up to 25 history entries.
- `POST /api/projects/:project/keys/:key/history/:event/restore`: `{version, language, side: "before"|"after", expectedSourceContext}`.
- `GET /api/projects/:project/trash?cursor=...`: up to 25 recoverable deleted keys.
- `POST /api/projects/:project/trash/:keyId/restore`: `{version}` from the trash listing.

Key IDs/generation markers are introduced on new writes. Existing keys do not need an eager rewrite. Existing names and versioned mutation endpoints remain supported; version numbers may skip after recovery or name reuse. Snapshots retain internal identity and freshness metadata.
