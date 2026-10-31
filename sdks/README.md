# Keylo mobile delivery

These small source SDKs fetch **published translation releases** from a self-hosted Keylo installation. Copy updates require an initial app integration; they do not update the application's code or add screens. Managers publish explicitly under **Developers → Live app delivery**; no review workflow is involved.

Create a delivery key for each app. These keys are public, extractable read credentials: bundle only non-confidential copy. They cannot read drafts, export data, call MCP or edit a project. Revocation stops future downloads, not access to copy already cached on a device.

Use an HTTPS origin, exact project ID and canonical language code (for example `pt-BR`). Channels are `production` (default) or `preview`. Keep bundled fallback strings for every key. On startup, load the SDK's cache, render immediately from it or bundled strings, and refresh in the background. Rebuild/re-render after a successful refresh. Fetching runs separately from string lookup. No SDK installs a lifecycle hook automatically.

All clients validate the project/language/schema, cap responses at 2 MiB, reject redirects and keep their previous bundle on errors. The token is sent in an Authorization header and never written to the cache. Give each client instance its own cache directory, particularly when running multiple origins or processes. Do not share a writable cache between processes. Use your platform's application-private cache directory. Android needs INTERNET permission (included in the library manifest).

## iOS / Swift

Add `swift/` as a local Swift package, then add the Keylo library to your app (iOS 15+). Keep the actor in your application model:

```swift
import Keylo
let directory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
let copy = try KeyloClient(baseURL: URL(string: "https://copy.example.com")!,
    project: "mobile", locale: "en", deliveryKey: "YOUR_DELIVERY_KEY", cacheDirectory: directory)
let title = await copy.text("home.title", fallback: "Welcome")
Task {
    if await copy.refresh() {
        // Reload your observable view model on the main actor.
    }
}
let items = await copy.text("cart.items", fallback: "3 items", arguments: ["count": "3"])
```

## Android / Kotlin

Include `android/` as a library module in your Gradle project. The standalone module uses Gradle 8.11.1, AGP 8.9.2, Kotlin 2.2.21, JDK 17, compile SDK 35 and min SDK 24. Adjust its plugin versions to your application's compatible versions when integrating. Import `io.keylo.KeyloClient`:

```kotlin
val copy = KeyloClient("https://copy.example.com", "mobile", "en",
    "YOUR_DELIVERY_KEY", File(context.cacheDir, "keylo"))
val executor = Executors.newSingleThreadExecutor()
copy.refreshAsync(executor) { changed ->
    if (changed) { /* schedule your observable UI update */ }
}
val title = copy.text("home.title", "Welcome")
val items = copy.text("cart.items", "3 items", mapOf("count" to "3"))
// Shut down the executor with your application's lifecycle.
```

`refresh()` is blocking and must run off the main thread. For coroutine applications use `withContext(Dispatchers.IO) { copy.refresh() }`. It uses a 10-second connect/read timeout. Concurrent refreshes are serialized; lookups keep using the last installed bundle.

## Flutter mobile

Add a path dependency pointing to `flutter/` in your app's `pubspec.yaml`. This is a native `dart:io` client, not a Flutter Web client. Choose a private cache directory using your app's existing storage setup (for example `path_provider`).

```dart
import 'package:keylo/keylo.dart';
final copy = await KeyloClient.open(
  baseUrl: Uri.parse('https://copy.example.com'), project: 'mobile', locale: 'en',
  deliveryKey: 'YOUR_DELIVERY_KEY', cacheDirectory: cacheDirectory);
final title = copy.text('home.title', fallback: 'Welcome');
if (await copy.refresh()) { /* notify your application state */ }
final items = copy.text('cart.items', fallback: '3 items', arguments: {'count': '3'});
```

## Formatting contract

Plain text, named arguments (`{name}`), ICU `select`, cardinal/ordinal plurals, exact selectors, offsets, nested choices and ICU apostrophe quoting are compiled into a declarative message tree at publication. Key references resolve when publishing. Number/date/time formatters and ICU skeletons require application formatting: format values locally, pass them as named arguments, or use exported ICU files with your preferred formatter. Unsupported OTA messages prevent publication with an actionable error; they are never silently flattened.

For plurals, pass counts as decimal strings in `arguments`. The variable is the one declared by the key (`count` by default). Counts must be finite, at most 1e12 in absolute value, with up to nine decimal places. Bundles carry Unicode CLDR 48 cardinal and ordinal predicates, including decimal operands. Counts are normalized without trailing zeroes and compact-number exponents. `#` uses platform-localized number formatting; the selected form falls back to `other`. Missing arguments or malformed messages return the supplied bundled fallback. Translation text is returned as text: do not execute it or interpret it as unsanitized HTML.

Clients do not replace native `NSLocalizedString`, Android `R.string` or Flutter generated localization lookups automatically. Use the explicit lookup API at copy locations you want to update. New language choices and keys must already be reachable in your app; publishing strings alone cannot create application navigation or language selection behavior.

## Verification

Run `swift test --package-path swift`, `gradle -p android testDebugUnitTest assembleDebug` with Android SDK 35/JDK 17, and `dart pub get && dart analyze && dart test` inside `flutter/`. Shared fixtures are generated by `node --import tsx scripts/sdk-fixtures.ts`; native tests exercise those same publication trees and CLDR rules. See the repository mobile SDK workflow for reproducible builds.
