# Workspace administration

Workspace administrators can open **Workspace admin** in the sidebar or **Admin → Workspace overview**. The area has three sections:

- **Overview:** project count, total keys, current target-language values and values needing attention; a searchable, paginated per-project breakdown; and new-project import actions.
- **People & access:** built-in account invitations, activation/reset links, project roles, disabling and session revocation, or the existing SSO directory controls. Demo mode explains how to enable team authentication instead of creating pretend users.
- **Security:** the current sign-in method and where to manage access and integration credentials. Changing authentication mode remains an operator configuration task.

`/admin`, `/admin/people` and `/admin/security` support direct links and browser navigation. `/users` remains a compatible entry point to People & access. Members and integration credentials cannot read the workspace overview API (`GET /api/workspace/overview`); user management retains its existing backend authorization.

Statistics count target-language values, excluding source languages. One key with three target languages contributes three target values. A source-only project contributes keys but no target values. Current excludes outdated and incomplete copy. Refresh explicitly after changes; the timestamp identifies when statistics were collected. Totals are an operational view collected across projects, not a transactionally consistent accounting snapshot. Reads run with bounded concurrency; plural/reference projects use the existing derived-view cache and scale limits described in [message semantics](messages.md#scale).

## Unique project names

The create/settings form checks visible existing projects and disables submission for duplicate names or IDs, with inline explanations. The server enforces unique names across the workspace, including API imports, renames and snapshot restoration. Name comparison ignores case, surrounding/repeated whitespace and Unicode compatibility variants. IDs remain unchanged and independently unique.

New names are reserved in the same SQLite/DynamoDB transaction as the project change. Concurrent attempts cannot both claim the same name. Existing projects are checked even if they predate name reservations. No migration or renaming of existing projects is required; pre-existing duplicate names remain usable but a rename must select an available name. A snapshot restoring a name now owned by another project is rejected before restoration begins. Other concurrent conflicts return 409; refresh to see the latest workspace state.

In local demo mode, HTTP loopback aliases on the request's port are supported, including when Astro selects another port. Built-in-account and production requests still require the exact configured `APP_ORIGIN`; a genuine mismatch returns an origin-specific configuration error rather than being treated as a duplicate name.
