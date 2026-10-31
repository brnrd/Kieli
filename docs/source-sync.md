# Source synchronization and CI

Managers create **Developers → Source sync for CI** credentials. They belong to the project integration, rather than the issuing person's browser session. Each is restricted to one project, source-language writes and optionally key-name prefixes. For example, `home., billing.` permits names starting with either exact prefix. An empty prefix list permits all source keys in that project. Tokens expire in 1–365 days (default 90), expose last-used time, are stored only as SHA-256 digests and are shown once.

These credentials can preview/apply source updates through `/sync/:project/...`. They cannot read target translations, export files, authenticate MCP, use browser APIs, change settings/users, delete keys, or change existing key metadata. Prefix checks use key names, not caller-controlled namespaces. New source keys may include their namespace/context; existing metadata is retained. The source locale must match the configured project source. Use **Update from files** for target-language uploads.

Source-only credentials deliberately authorize the repository to update source copy for their key prefixes. Use separate prefixes/projects for copy with different ownership. Human source edits can conflict with an in-flight preview; a later explicit repository push can propose replacing them. Target translations are always preserved and become outdated after a source change.

## Repository configuration

Copy [`.keylo.json.example`](../.keylo.json.example) to `.keylo.json` in the consuming repository. File mappings are explicit paths, not globs, and resolve relative to that configuration file. CLI overrides take precedence; `KEYLO_URL`, `KEYLO_PROJECT` and `KEYLO_SOURCE_LANGUAGE` can override config defaults. Credentials are environment variables, never configuration fields.

```sh
# Preview only; this is the default. Uses KEYLO_SYNC_TOKEN from the environment.
node cli/keylo.mjs push --config .keylo.json

# Apply the version-checked source changes.
node cli/keylo.mjs push --config .keylo.json --apply

# Or push one source file without configuration.
node cli/keylo.mjs push --url https://copy.example.com --project website \
  --source ./locales/en.json --language en --format nested --apply
```

Push currently accepts flat or nested JSON source files. Values must be strings; use ICU strings for plurals. Category objects, arrays and executable input are rejected. Duplicate flattened keys/across-file keys are rejected. Files are limited to 10 MiB each, 25 MiB total, 100 mappings and 50,000 keys. References to keys in the input are ordered dependency-first. Other format adapters remain available in browser import and export; the portable CLI intentionally uses Node built-ins only.

All source files are parsed and previews are requested before live writes begin. Push defaults to dry-run; `--apply` is explicit and cannot be combined with `--dry-run`. A dry-run stages private server previews but does not change project copy. Previews/receipts expire after 24 hours. Batches are bounded by count and byte size; each write is atomic. Network failures can retry an apply using its durable receipt. A concurrent edit causes an error instead of an overwrite; successful earlier batches remain saved. Rerun a dry-run and inspect it before applying again.

Push never removes absent keys or clears strings with blank values. Repeating unchanged source files does not create translation-history edits. Applied changes record the credential name and `sync` origin. The CLI exits nonzero on failures and prints counts/errors without source text or bearer secrets.

## CI integration

Keep the source-sync secret in the CI secret store as `KEYLO_SYNC_TOKEN`. Run write jobs only for trusted branches/workflows; untrusted pull requests must not receive write secrets. Export/pull uses a separate read-only `KEYLO_TOKEN`.

```yaml
- name: Push source copy
  env:
    KEYLO_SYNC_TOKEN: ${{ secrets.KEYLO_SYNC_TOKEN }}
  run: node cli/keylo.mjs push --config .keylo.json --apply

- name: Pull translations
  env:
    KEYLO_TOKEN: ${{ secrets.KEYLO_TOKEN }}
  run: node cli/keylo.mjs pull --config .keylo.json
```

Revoking a source-sync credential blocks subsequent requests and an in-flight write whose commit races the revocation. Browser logout, password changes and personal session revocation do not revoke project service credentials. Rotate them separately when a CI integration or repository access changes. They are independent of authentication mode; outstanding update previews are additionally bound to the mode in which they were created.

Requests require the dedicated bearer credential, matching configured public Host, JSON bodies and HTTPS outside loopback. Foreign Origin values are rejected; machine clients may omit Origin. A shared limit permits 240 requests/minute per credential; CLI requests retry bounded transient failures and rate limits. A successful read/operation already completed cannot be recalled.

Run `npm run smoke:sync` after building to verify config paths, dry-run/apply, target protection, credential separation, repeat behavior and revocation using disposable local fixtures.
