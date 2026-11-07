# Bulk tags and namespaces

Managers can select keys in the translation list and choose **Edit tags & namespace**. Selection applies to the current database page, up to 100 keys. It does not select every result across the project.

- **Add tags** keeps existing tags and adds exact, case-sensitive names once.
- **Remove tags** removes matching names. A tag cannot be added and removed in the same operation.
- **Change namespace** replaces the namespace on all selected keys. Leave it unchecked to keep namespaces; use `general` to move keys to the default namespace. Key names and references are unchanged.

The normal limits apply: 12 tags per key, 30 characters per tag, and a nonempty namespace of at most 60 characters. Commas separate tags in the browser. A preview rejects additions that would exceed a key's tag or storage limit rather than dropping tags.

## Preview, apply and continue

The server prepares a preview showing each key's original and proposed metadata, plus changed/unchanged totals. Previewing saves no key changes. **Edit changes** returns to the controls; applying uses the reviewed values.

Updates run in atomic batches of at most 10 keys, reduced further for large copy. Each batch checks project, key, counter and progress-record versions and saves key history, translation-memory pointers, search indexes, namespace counters and an audit event together. Metadata changes preserve translations, native format metadata, source revisions and freshness anchors. They do not mark outdated copy current or validate translation quality. Unchanged keys are checked and counted without new key versions or history entries. Disabled target languages do not prevent metadata changes; archived projects remain read-only.

Progress shows confirmed processed, updated and unchanged counts. A failed batch saves none of its changes; earlier batches remain saved. The selection clears processed keys after applying stops. List filters stay active; moving keys to another namespace can leave the current filtered list empty. **Preview remaining** fetches current versions and shows a new preview for unprocessed keys after a conflict. **Edit changes** also lets you adjust the operation for those remaining keys. Deleted or renamed keys require closing the dialog and selecting the intended current keys again.

For a connection failure, retry the existing preview. The client checks server progress first; retries of an already committed offset return its receipt without applying another batch. If progress cannot be read, the dialog labels the count as last confirmed and offers **Check progress** before allowing a fresh preview. Finishing leaves a visible result summary; **Done** closes it.

Closing is blocked while requests run, and browser reload/navigation gets the usual in-progress protection. Force-closing the browser can leave the current batch committed. There is no background job: later batches require another client request. Previews and receipts expire after one hour and may then be removed by storage TTL; after expiry, reload the project and inspect/reselect keys rather than assuming nothing was saved. Translation history and saved copy do not expire with the preview.

## API

All endpoints require a signed-in project manager or administrator. Previews belong to their immutable actor, authentication mode and project. Export, source-sync and MCP credentials cannot use them. Archived projects reject new previews and writes; completed progress remains readable by its authorized owner.

```http
POST /api/projects/web/metadata/preview
Content-Type: application/json

{
  "keys": [{"name": "checkout.title", "version": 3}],
  "operation": {
    "addTags": ["checkout"],
    "removeTags": ["legacy"],
    "namespace": "checkout"
  }
}
```

Read progress using `GET /api/projects/web/metadata/:previewId`. Apply the next bounded batch using:

```http
POST /api/projects/web/metadata/:previewId/apply
Content-Type: application/json

{"offset": 0}
```

Use the returned `processed` value as the next offset until `done` is true. Repeating an earlier offset returns current progress without advancing it; an offset ahead of progress rejects. Settings changes, snapshot restoration, key edits, renames or deletion invalidate affected pending work. Unrelated key writes are reconciled through the existing counter conditions.

No schema migration or deployment component is needed. New `METADATA_PLAN#…` records hold only previewed names/IDs, versions, namespaces, tags and progress, with storage TTL. Existing per-key history records use the `metadata` origin. Existing snapshots continue to capture keys as usual and do not include in-progress plans.

Verified locally using disposable SQLite databases, transaction races, 100-key/large-copy cases, compiled HTTP checks and browser interaction. Live DynamoDB/IdP verification remains separate.
