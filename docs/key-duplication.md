# Duplicate a key

Open a key's full editor and choose **Duplicate key…**. Enter a new, unique key name. Managers can copy the description, namespace and tags (enabled by default) and optionally enabled target translations (off by default).

Source copy, plural structure and native metadata for copied locales are retained. Disabled targets are omitted. References keep their original targets; duplication does not rewrite application code or inbound references.

The new key has an independent identity and starts its own history. Copied outdated translations stay outdated; current targets are checked against the duplicated source. Creating the duplicate follows normal name, size, placeholder and message validation. Unsaved drafts must be saved or discarded before duplication; the action copies persisted values.

`POST /api/projects/:id/keys/:name/duplicate` accepts `name` (new name), `version` (original key version), `copyContext` and `copyTargets`. Only signed-in managers may use it; archived projects and scoped integration credentials reject. Project, original key and counter conditions fence concurrent source/dependency changes and creation collisions. A conflict saves no duplicate; reload the original and try again. Existing copy and history are untouched, with no data migration required.

Local tests cover SQLite transactions, concurrent source changes, collisions, permissions, plural metadata, references and freshness; HTTP and browser fixtures exercise the deployed application build. Live AWS verification remains separate.
