# Source synchronization and CI

Managers create **Developers → Source sync for CI** credentials. They belong to the project integration, rather than the issuing person's browser session. Each is restricted to one project, source-language writes and optionally key-name prefixes. For example, `home., billing.` permits names starting with either exact prefix. An empty prefix list permits all source keys in that project. Tokens expire in 1–365 days (default 90), expose last-used time, are stored only as SHA-256 digests and are shown once.

These credentials can preview/apply source updates through `/sync/:project/...`. They cannot read target translations, export files, authenticate MCP, use browser APIs, change settings/users, delete keys, or change existing key metadata. Prefix checks use key names, not caller-controlled namespaces. New source keys may include their namespace/context; existing metadata is retained. The source locale must match the configured project source. Use **Update from files** for target-language uploads.

Source-only credentials deliberately authorize the repository to update source copy for their key prefixes. Use separate prefixes/projects for copy with different ownership. Human source edits can conflict with an in-flight preview; a later explicit repository push can propose replacing them. Target translations are always preserved and become outdated after a source change.

## Repository configuration

Copy [`.kieli.json.example`](../.kieli.json.example) to `.kieli.json` in the consuming repository. File mappings are explicit paths, not globs, and resolve relative to that configuration file. CLI overrides take precedence; `KIELI_URL`, `KIELI_PROJECT` and `KIELI_SOURCE_LANGUAGE` can override config defaults. Credentials are environment variables, never configuration fields.

```sh
# Preview only; this is the default. Uses KIELI_SYNC_TOKEN from the environment.
node cli/kieli.mjs push --config .kieli.json

# Apply the version-checked source changes.
node cli/kieli.mjs push --config .kieli.json --apply

# Or push one source file without configuration.
node cli/kieli.mjs push --url https://copy.example.com --project website \
  --source ./locales/en.json --language en --format nested --apply
```

Push currently accepts flat or nested JSON source files. Values must be strings; use ICU strings for plurals. Category objects, arrays and executable input are rejected. Duplicate flattened keys/across-file keys are rejected. Files are limited to 10 MiB each, 25 MiB total, 100 mappings and 50,000 keys. References to keys in the input are ordered dependency-first. Other format adapters remain available in browser import and export; the portable CLI intentionally uses Node built-ins only.

All source files are parsed and previews are requested before live writes begin. Push defaults to dry-run; `--apply` is explicit and cannot be combined with `--dry-run`. A dry-run stages private server previews but does not change project copy. Previews/receipts expire after 24 hours. Batches are bounded by count and byte size; each write is atomic. Network failures can retry an apply using its durable receipt. A concurrent edit causes an error instead of an overwrite; successful earlier batches remain saved. Rerun a dry-run and inspect it before applying again.

Push never removes absent keys or clears strings with blank values. Repeating unchanged source files does not create translation-history edits. Applied changes record the credential name and `sync` origin. The CLI exits nonzero on failures and prints counts/errors without source text or bearer secrets.

## CI integration

Keep the source-sync secret in the CI secret store as `KIELI_SYNC_TOKEN`. Run write jobs only for trusted branches/workflows; untrusted pull requests must not receive write secrets. Export/pull uses a separate read-only `KIELI_TOKEN`.

```yaml
- name: Push source copy
  env:
    KIELI_SYNC_TOKEN: ${{ secrets.KIELI_SYNC_TOKEN }}
  run: node cli/kieli.mjs push --config .kieli.json --apply

- name: Pull translations
  env:
    KIELI_TOKEN: ${{ secrets.KIELI_TOKEN }}
  run: node cli/kieli.mjs pull --config .kieli.json
```

Revoking a source-sync credential blocks subsequent requests and an in-flight write whose commit races the revocation. Browser logout, password changes and personal session revocation do not revoke project service credentials. Rotate them separately when a CI integration or repository access changes. They are independent of authentication mode; outstanding update previews are additionally bound to the mode in which they were created.

Requests require the dedicated bearer credential, matching configured public Host, JSON bodies and HTTPS outside loopback. Foreign Origin values are rejected; machine clients may omit Origin. A shared limit permits 240 requests/minute per credential; CLI requests retry bounded transient failures and rate limits. A successful read/operation already completed cannot be recalled.

Run `npm run smoke:sync` after building to verify config paths, dry-run/apply, target protection, credential separation, repeat behavior and revocation using disposable local fixtures.

For a build that must contain only current, complete translations, use `node cli/kieli.mjs pull --config .kieli.json --require-current`. This also checks argument contracts in existing copy and fails before writing locale files. It can be set as `pull.requireCurrent: true` in repository configuration. Ordinary pulls retain their existing fallback/export behavior.

## A friendlier terminal

Interactive terminals show **Kip**, Kieli's little key character, with a restrained green header, short progress stages, file paths and a timed completion summary. The character is original ASCII artwork and needs no fonts, downloaded assets or extra packages.

```text
   .--.
  (o  o)---+  kieli
   '--'   |   Your words, ready to travel.

  website  pull

  > Fetching translations…
  > Writing 2 locale files…

  + Pulled 2 languages from website:
  | /your/app/locales/en.json
  | /your/app/locales/fr.json

  Done in 0.4s.
```

Use `node cli/kieli.mjs --help` for grouped commands and examples. Help works even if the repository configuration is malformed. This presentation does not add an interactive setup wizard, prompts, telemetry or implicit writes; source push still defaults to dry-run.

Piped output, CI and `TERM=dumb` automatically use plain output, retaining the existing pull/push result lines and nonzero failure exit codes. Add `--plain` to opt out in a terminal. `--no-color` or the presence of `NO_COLOR` disables ANSI color while keeping the interactive character and stage lines; narrow terminals use a compact header. No animation or cursor-control sequences are emitted.

Displayed dynamic paths and errors have terminal control characters removed, and configured Kieli credential values are redacted. Set credentials through environment variables as described above, never in command-line arguments or configuration files. The CLI remains a single file using Node built-ins only.
