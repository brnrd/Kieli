# Rename a key

Open a key's editor and choose **Rename key…** beneath its name. This action is available to signed-in project managers and administrators. Save your draft first, or discard it when prompted.

Enter a new name and choose **Preview rename**. The preview lists keys with exact `[%key:old.name%]` references and their languages, plus the total number of affected records. Choose **Rename key** to commit the changes together. Name collisions, unresolved references already using the proposed name, invalid names and concurrent changes stop the operation. Refresh a stale editor before trying again.

The key keeps its stable identity, translations, native metadata, creation time and history. Key versions increase; before/after names appear in history. References in every configured language are rewritten, including references inside plural messages. Related source-context stamps change without certifying outdated translations as current. Transitive dependents receive newer versions when their context changes. Counts and completion remain unchanged.

Update the key name in your application source, source-sync files and other external consumers yourself. Keylo creates no alias for the old name. Existing published mobile releases and snapshots remain immutable; publish a new release when ready. Source-syncing an unchanged old file can recreate the former key name as a separate identity.

## Atomicity and recovery

The backend scans the active project's keys to calculate reference impact. Both storage drivers use the same conditional transaction, guarded by project, statistics, key and name-generation versions. Even a newly added reference invalidates an earlier preview. The operation fails before committing if it exceeds 100 transaction items or the conservative 3.5 MiB transaction budget; this includes history, previous-translation pointers, counters and audit records, so the maximum affected key count varies. There is no partial rename or background batch.

No data migration is needed. Older keys receive their deterministic legacy identity on rename. Historical text and names stay unchanged; previous-translation lookup follows active identities when a historical name no longer matches. That fallback may read the project's active key list. Deleted identities and inactive snapshot datasets remain excluded.

To undo, preview a rename back to the former name, provided that name is free and the operation fits the same bounds. Project snapshots offer broader recovery and retain their own original names. A full database backup remains necessary for immutable history and security audit recovery. Restoring old per-language history does not rename a key or rewrite historical references.

## API

- `POST /api/projects/:project/keys/:key/rename-preview`: `{ "name": "new.name", "version": 3 }`.
- `POST /api/projects/:project/keys/:key/rename`: `{ "name": "new.name", "version": 3, "projectVersion": 1, "statsVersion": 12 }`, using versions returned by preview. The response is the renamed key.

Both endpoints require browser authentication and manager access. Export, source-sync and MCP credentials cannot rename keys. The apply endpoint recomputes impact and checks the supplied versions before committing. Retries after a successful rename fail against the removed old name; reload the project to confirm the result.

Local regression and HTTP tests cover races, rollback, references, freshness, history and credential separation. Live DynamoDB workload verification remains a staging task.
