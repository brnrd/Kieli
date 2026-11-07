# Export selected keys or a namespace

Select keys on the current translation-list page and choose **Export selected**. The export dialog also offers **All project keys** and **A namespace**. Choose languages, format and fallback as usual. Selected-key exports accept up to 100 explicit names; namespace exports include all matching keys across database pages.

CLI examples:

```sh
node cli/kieli.mjs pull --url https://copy.example.com --project web --keys home.title,home.cta --languages fr --out ./locales
node cli/kieli.mjs pull --url https://copy.example.com --project web --namespace checkout --out ./locales --require-current
```

`--keys` and `--namespace` cannot be combined. These are command-line pull filters; existing repository configuration remains unchanged. On source push, `--namespace` retains its existing meaning for new source keys.

API exports accept `keys=home.title,home.cta` or `namespace=checkout` on the existing `GET /api/projects/:id/export` endpoint. Omitting both exports the whole project. Empty selections, invalid names, missing selected keys and empty namespace results reject rather than silently widening the export. Duplicate key names are deduplicated. Large explicit name lists can exceed deployment URL limits; select fewer keys or use a namespace in that case.

References resolve using the full project before filtering, so a selected linked key can export resolved copy without adding its dependency keys to the output. Strict freshness checks apply to selected output keys and locales. Plurals, native metadata, source fallback, ZIP filenames and CLI file protections retain their existing rules. Missing/outdated copy elsewhere does not block a strict subset export. Exports are not atomic directory replacements: previously downloaded files and keys are not automatically cleaned up.

Project roles and scoped export credentials apply unchanged. Archived projects and explicit disabled-language exports remain readable. This is a selection filter, not a new credential scope: export tokens still grant project-wide export access. Subset exports use the existing project read/resolution path and do not add a storage index or reduce every underlying database read.

No migration or deployment changes are required. Local SQLite, HTTP/CLI and browser fixtures verify the behavior; live AWS verification remains separate.
