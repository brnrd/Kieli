# Archive and restore projects

Managers and administrators can choose **Settings → Archive project**, then confirm. The project disappears from the sidebar and the directory's default **Active** view. In **All projects**, choose **Archived** or **All projects** to find it. Its page displays an **Archived · Read-only** banner. Existing project memberships continue to control access; archiving grants no new permissions.

Open the archived project's settings and choose **Restore project** to return it to navigation and resume editing. Existing users and integration grants apply again. Archive/restore changes are audited with actor, project, time and outcome. The archive timestamp and actor name appear in settings. IDs and names remain reserved while archived.

## What stays available

- Reading and searching copy, translations, history and terminology; viewing settings and deleted-key records.
- Browser exports, existing export tokens and CLI/CI pulls, including normal freshness checks. Expiration and revocation still apply.
- Existing published mobile releases, delivery credentials and cache validation.
- Creating/downloading snapshots and existing scheduled backups. Retention and maintenance continue normally: archiving is not a retention freeze or an offboarding mechanism.
- Credential management and revocation, plus derived history indexing. Credentials do not bypass archive restrictions. Archiving does not sign people out or revoke their grants.

## What becomes read-only

The backend rejects key creation/editing/deletion, key renaming, imports/source sync, glossary mutations, translation/deleted-key restoration, project settings/snapshot-schedule changes, snapshot restoration, mobile publication and channel switching. MCP can still read within its grant, but cannot save translations. Restore the project before making these changes.

Stale browser pages may still show edit controls until refreshed, but the server rejects writes. Content mutations use the same project-version transaction fence as archive/restore in SQLite and DynamoDB. An in-flight write that loses the race cannot commit visible copy or publication changes. Multi-stage snapshot/mobile work may leave temporary staged records for normal maintenance cleanup. Existing import previews become stale even after archive/restore; preview again.

## Data compatibility and recovery

No eager migration is needed: projects without `archivedAt` are active. Archiving adds optional `archivedAt` and `archivedBy` fields to the project record and increments its version; restoring removes those fields. Keys, native metadata, freshness, counters, history, glossary and project settings are not rewritten. Archive status is workspace lifecycle metadata, not translation-snapshot content; a snapshot restore cannot activate an archived project. Restore the project explicitly first.

Restore through the settings action or API rather than editing the database. Full database backups preserve archive metadata and audit history. Older Keylo versions do not enforce archived read-only behavior; restore or account for archived projects before rolling back to an older release.

## API

`POST /api/projects/:project/archive` accepts `{ "version": 4, "archived": true }`, or `false` to restore. It requires a signed-in project manager; export, sync and MCP credentials are rejected. It returns the updated project. A stale version returns 409; a request for the already-current state with the current version is a no-op. The bootstrap response retains accessible archived projects so clients can offer an explicit archived view.

Local tests cover authorization, data preservation, archive/edit races, mobile publication races, existing exports and real CLI downloads. Live DynamoDB workload verification remains a staging task.
