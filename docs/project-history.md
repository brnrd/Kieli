# Project snapshots and recovery

Project managers and workspace admins manage snapshots under **Project settings → Project snapshots**. A snapshot captures keys, raw translations (including references and ICU plurals), author timestamps, descriptions, tags and language/plural settings. It does not copy accounts, sessions, project assignments or credentials. Manual and safety snapshots stay until an operator removes them through storage administration; there is no automatic expiration for them.

Restoring verifies a canonical SHA-256 checksum and expected project version, creates a safety snapshot of current data, stages a fresh dataset, then atomically changes the project's active revision. Concurrent key edits and other restores are protected with conditional writes. A failed staging operation never changes the active revision. Restored key versions exceed current and captured versions, so stale editor/MCP requests conflict. Restore preserves current snapshot scheduling, user access and published OTA releases. An already published release changes only through explicit publish/activate actions.

Download reads bounded snapshot parts and checks the checksum in the browser. The `.keylo.json` backup is readable JSON; it contains project settings and keys, not credentials. It can also be retained externally. The UI restores snapshots stored in Keylo; uploading a downloaded backup is not yet a recovery UI. For whole-installation disaster recovery use SQLite backups or DynamoDB point-in-time recovery, including all snapshot records.

Snapshots support up to **20 MiB of key text per project**. Parts stay below DynamoDB's item limit, and snapshot downloads use separate requests rather than exceeding Lambda's synchronous response limit. Restore temporarily needs storage for the current, staged and safety copies. Abandoned/restored revisions are collected after one hour; failed snapshot/release staging records after one day. Published OTA releases remain available for rollback. Manual snapshots and released bundles require an operator retention policy if long-term storage growth matters.

## Automatic snapshots

Choose daily or weekly snapshots and retain 2–30 automatic copies (default 7) per project. The scheduler checks every five minutes. Disabled schedules do not create snapshots. The next successful maintenance run enforces retention, and failed captures retry on subsequent runs. Administrators should monitor job failures; scheduling is not a replacement for database backups.

Both AWS templates include an EventBridge schedule, a small isolated runner Lambda and a generated Secrets Manager job credential. The runner can only read that secret and invoke the application Lambda. Application requests to `POST /tasks/snapshots` require this dedicated credential; browser sessions, export tokens, MCP credentials and OTA keys do not authorize the job. Calls are serialized with a shared lease. A saved project cursor rotates work across installations with many projects; a failing project does not continually prevent later projects from being visited. Each run starts no new project after its 20-second work window. A large project that exceeds the application's Lambda timeout requires splitting the project or moving maintenance to a longer-running operator job.

For Docker/Node installations, generate a random secret (`openssl rand -hex 32`) and configure `KEYLO_SNAPSHOT_JOB_TOKEN` on the server and the operator scheduler. Keep it outside Git and out of URLs. Run the following every five minutes using the host's scheduler:

```sh
APP_ORIGIN=https://copy.example.com npm run snapshots:run
```

Load the token from the scheduler's protected environment or `.env` file. `snapshots:run` sends it in the Authorization header, fails on partial failures, rejects redirects and permits HTTP only for loopback development. The job endpoint returns 503 until configured. AWS sets `KEYLO_SNAPSHOT_JOB_SECRET_ARN` instead and rotates warm secret reads every five minutes; update both caller and server together if replacing the secret.

## API

All snapshot API endpoints require project manager access:

- `GET/POST /api/projects/:id/snapshots` — list or create (`{label}`).
- `GET /api/projects/:id/snapshots/:snapshot` — backup manifest/checksum.
- `GET /api/projects/:id/snapshots/:snapshot/parts/:index` — a bounded part.
- `POST /api/projects/:id/snapshots/:snapshot/restore` — restore (`{version: currentProjectVersion}`).

Snapshot creation/restoration and OTA publication/channel/credential changes record security audit events. Text and delivery secrets are not written to audit details.
