# Lokalise import

Import is available to workspace admins from **Admin → Import from Lokalise**. It creates a new Kieli project. It never merges into an unrelated existing project or replaces existing translations. Other localization files can use **Admin → Import translation files**; see [supported adapters](file-formats.md).

## JSON export ZIP

In Lokalise's Download screen, select JSON, all required languages, one file per language, and `%LANG_ISO%.json`. Include all platform keys and untranslated strings; keep missing translations empty and preserve placeholders as needed by your app. The ZIP can contain a directory prefix such as `locale/`:

```text
locale/en.json
locale/fr.json
locale/nl.json
```

Both flat and nested JSON are supported. The file basename identifies the locale. Nested objects become dotted keys and can be reconstructed with Kieli's nested export. Existing dotted/nested collisions, arrays, numbers, null values, unsafe names, and duplicate normalized locales cause a clear error before project creation. Underscore locales such as `en_US` are converted to canonical BCP 47 (`en-US`) and shown as warnings. Select the source language explicitly in the preview.

JSON translation exports do not contain all project metadata. Name the destination project in the preview. Use a snapshot if you need descriptions and tags.

## API snapshot

A `.json` snapshot combines the Lokalise project, project-language list, and key list (with translations). Concatenate all API pages before creating this file; Kieli cannot infer missing pages from an incomplete snapshot.

```json
{
  "project": {
    "name": "Acme website",
    "base_language_iso": "en",
    "description": "Website copy"
  },
  "languages": [
    { "lang_iso": "en", "lang_name": "English" },
    { "lang_iso": "fr", "lang_name": "French" }
  ],
  "keys": [
    {
      "key_name": { "web": "home.title", "ios": "homeTitle" },
      "description": "Homepage headline",
      "tags": ["hero"],
      "translations": [
        { "language_iso": "en", "translation": "Welcome" },
        { "language_iso": "fr", "translation": "Bienvenue" }
      ]
    }
  ]
}
```

Choose Web, iOS, Android, or Other for per-platform key names. Keys without a name for that platform are explicitly excluded with a warning requiring acknowledgement. Review settings, screenshots, automated translation providers, and comments are outside Kieli's model and are not imported. Plural objects stay as one ICU plural key with a form editor per language. Numeric reference placeholders map to the selected platform’s key names. Mixed incompatible plural encodings are rejected rather than silently converted.

A sample API snapshot is included at `docs/examples/lokalise-snapshot.json`.

## Reliability and limits

Preview parsing happens in a browser worker; the file is not uploaded just to preview it. A confirmation starts the project import, and each batch is validated again on the server. Batches of at most 20 keys commit atomically with aggregate counters. Retry after a network failure is idempotent within that import and never replaces already-saved edits. Completed batches persist if a later batch fails; keep the dialog open to continue. Closing/reloading the dialog loses its retry state, so a fresh import must use a new project ID.

Limits: 10 MB input, 25 MB uncompressed ZIP data, 1,000 ZIP entries, 30 languages, 50,000 keys, 120 KB per key, and 20,000 characters per individual translation. The editor requires key names of at most 180 ASCII letters/numbers/dots/underscores/hyphens, with no empty or reserved prototype segments. Export from Lokalise in a compatible naming convention or adjust invalid entries before retrying.

References: [Lokalise download settings](https://docs.lokalise.com/en/articles/3150682-downloading-translation-files), [file structure](https://docs.lokalise.com/en/articles/2281317-filenames), [key API](https://developers.lokalise.com/reference/list-all-keys), [API pagination](https://developers.lokalise.com/reference/api-pagination).
