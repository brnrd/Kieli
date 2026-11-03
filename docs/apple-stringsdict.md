# Apple native plural dictionaries

Import `.stringsdict` files through **Admin → Import translation files** or **Update from files**. Choose **Apple strings + plural dictionaries** when exporting, or use CLI `--format stringsdict`. Kieli converts supported native rules to its ICU plural editor and writes native resources again on export.

## Supported subset

Each XML plist entry must have one `NSStringLocalizedFormatKey` equal to a standalone `%#@variable@`, plus that variable's dictionary containing `NSStringFormatSpecTypeKey=NSStringPluralRuleType`, `NSStringFormatValueTypeKey` and Unicode cardinal category strings. `other` is required. Variable names use ASCII letters/digits/underscores, starting with a letter/underscore.

Supported integer types are **`d`, `ld`, `lld`**. Each form can contain literal text, escaped `%%` and at most one count formatter matching its declared type (`%d`, `%ld`, `%lld`). A form may omit the formatter, for example “One item”. Kieli preserves category names, variable names, integer widths, literal percent signs, apostrophes, braces, hash signs, whitespace and Unicode. XML layout, comments, headers and dictionary order are regenerated.

The adapter rejects format prefixes/suffixes outside the variable, multiple variables, repeated/positional arguments, width/precision modifiers, other printf arguments/types, literal Kieli reference markers, nested rules, exact-number selectors, offsets, ordinal rules and device/width variants. Binary plists, unknown properties, duplicate entries, malformed XML, inline markup, DTDs and custom entities are rejected. Only Apple's fixed standard plist DOCTYPE is stripped; nothing is fetched or executed. Unsupported structures produce an error instead of being flattened.

Kieli's existing key-ID rules still apply: at most 180 ASCII letters/digits/dots/hyphens/underscores, without unsafe/empty segments. Apple prose or format-string keys such as `%d file(s) remaining` need an explicit application/key migration; Kieli never silently renames them. A key's variable contract must agree across languages, as required by normal placeholder validation.

## Files and native app use

Use names such as `en.lproj/Localizable.stringsdict`, `ru.lproj/Localizable.stringsdict`, or `<locale>.stringsdict`. A ZIP can also contain disjoint `.strings` files for plain copy. A key/language pair may appear only once: remove duplicate fallback entries from `.strings` before importing the same key from `.stringsdict`.

An export creates **two files per selected locale**, including empty companions:

- `<locale>.stringsdict` contains plural keys.
- `<locale>.strings` contains plain keys, without duplicate plural entries.

```sh
node cli/kieli.mjs pull \
  --url https://copy.example.com --project mobile \
  --languages en,ru --format stringsdict --out ./locales
```

The CLI checks both extensions, duplicate filenames, requested locales and safe paths before writing. Replacement is atomic per file, not across the pair or whole directory; stop your build if pulling fails. Place matching pairs in your app's locale folders with the **same table basename**, for example `en.lproj/Localizable.strings` and `en.lproj/Localizable.stringsdict`. Merely downloading files does not add them to an Xcode target.

Use the native localized-string lookup and pass an argument matching the exported integer type. For a `d` count, for example:

```swift
let format = NSLocalizedString("cart.items", comment: "Cart item count")
let message = String.localizedStringWithFormat(format, Int32(count))
```

Use the corresponding C-compatible long/long-long argument for `ld`/`lld`; verify the call site and supported platforms. Imported types are retained per locale. A newly added locale inherits the source locale's type when it has no explicit type. A plural created from ICU without Apple metadata defaults to `d`; do not assume an imported/native `NSInteger` or 64-bit calling convention without checking it.

Without fallback, native export preserves the ICU message's supplied categories. An empty target becomes a valid empty `other` rule using the source variable. Selecting source fallback explicitly prepares missing categories from source using the existing export behavior. `--require-current` still applies Kieli's configured required categories and placeholder/freshness checks; set project locale overrides if your application's accepted category subset differs.

## Metadata, edits and recovery

Keys optionally store `applePluralTypes: {"en":"ld","ru":"ld"}`. This additive field needs no migration of existing data. Imports record it automatically. Normal browser/MCP/source-sync translation edits preserve it; only a project manager can change it explicitly through the versioned key API. Metadata locale codes must be configured project languages. Project-update previews show type changes; merge preserves populated target metadata, while overwrite allows supplied target type changes. Source-sync credentials cannot supply this metadata.

History, deleted-key recovery, project snapshots and snapshot downloads preserve the field. Restoring a historical translation also restores that language's recorded Apple type. Existing snapshots without the field retain the documented `d` default. Keep normal database/snapshot backups before upgrades; earlier Kieli binaries do not understand the new metadata field and their saves/snapshots may discard it. For rollback, restore the pre-upgrade database backup or retain native exports for reimport after upgrading again; do not rely on an older binary to preserve native-format fidelity.

JSON/YAML/ARB text exports remain ICU interchange and do not carry Apple integer metadata; use native export or project snapshots when that metadata must survive migration. Kieli's OTA SDK uses its explicit compiled-message API; native file export does not replace or configure that integration. This adapter does not implement `.xcstrings`, `.xcloc` or an Xcode project import pipeline.

## Verification

Independent synthetic golden fixtures compare native dictionary keys, types and form strings after import/export. Regression tests cover mixed files, unsupported structures, CLI filename attacks, authorization, edit conflicts, update policies, history, trash and snapshots.

After building, run `npm run smoke:apple` for compiled HTTP import, scoped JSON/ZIP exports and real CLI downloads. On macOS with Swift/Foundation installed, run `npm run smoke:apple -- --native` to render the exported English/Russian resources, 32-bit/long/long-long arguments, literal percent signs and quoted punctuation. This passes locally; it is not a test of your iOS app, Xcode resource integration or every Apple locale/runtime.

References: [Apple plural localization](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPInternational/LocalizingYourApp/LocalizingYourApp.html), [current Apple plural guidance](https://developer.apple.com/documentation/xcode/localizing-strings-that-contain-plurals).
