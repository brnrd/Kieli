# Live app translation delivery

Managers use **Developers → Live app delivery** to publish a complete project into an immutable `preview` or `production` release. Every enabled project language and configured plural category must be complete. [Disabled targets](project-languages.md) are excluded from new releases; existing release bundles remain available. A channel moved to a release without a locale returns no bundle for that locale, so SDKs retain their cached/embedded fallback. References resolve at capture time. Draft changes stay private to the editor until another explicit publish; there is no review or approval workflow.

The channel pointer changes conditionally, so two concurrent publishers cannot overwrite each other silently. Activate an earlier release to roll back a channel without restoring draft project data. Releases and their source snapshots are retained; failed publication never moves a channel. This is independent of project snapshot restoration.

Create one delivery key per app. Only its hash is stored and the secret is shown once. Delivery keys are extractable public read credentials: **do not publish confidential copy**. They cannot read drafts, use exports/MCP, change translations or trigger maintenance. Revoking a delivery key blocks its next fetch, including a conditional ETag request. Previously downloaded copy remains on devices.

SDK sources for Swift, Kotlin and Flutter mobile are downloadable in Developers, or available in [`sdks/`](../sdks/README.md). Configure the HTTPS origin, project, locale, delivery key and channel, call refresh at launch, and keep bundled fallback strings. Applications must integrate the explicit lookup APIs once; native localization APIs are not automatically intercepted. Clients retain the last valid bundle across failures and use bundled fallback when a key, argument or message cannot be formatted. A key or language must already be reachable through your app's UI to become usable after an OTA update.

## Delivery protocol

```http
GET /ota/mobile/en?channel=production
Authorization: Bearer klo_mobile.…
If-None-Match: "previous-sha256"
```

Responses are a schema-1 JSON bundle with project/locale/release, declarative message nodes and Unicode CLDR 48 cardinal/ordinal predicates. `200` installs a new bundle; an authenticated `304` keeps the cache. Headers include ETag, `Cache-Control: private, no-cache` and `Vary: Authorization`. There is no anonymous public bundle URL, CORS wildcard or delivery-key query parameter. Maximum uncompressed language bundle is **2 MiB**, and project snapshot capture is limited to 20 MiB of raw key text. Bundles are stored in bounded DynamoDB parts with a SHA-256 integrity check before delivery. A missing/corrupt part returns 503 so SDKs retain their cache.

Supported message features: text, named arguments, select, cardinal and ordinal plurals, exact selectors, offsets, ICU apostrophe quoting and nested choices. Dates/times/number skeletons require application formatting into named arguments or a separately integrated ICU formatter using file exports. Unsupported constructs block publication with a key/language-specific error. Translation bundles contain no executable code. Clients reject redirects, validate HTTPS/project/language/schema, limit download bytes, and atomically replace a private cache after validation. TLS provides authenticity; this version does not add offline cryptographic release signing.

The AWS HTTP API applies throttling. Every launch still authenticates and checks the channel in DynamoDB, even for a 304. Plan capacity/cost for app startup traffic before a large rollout; this version does not add a CDN, automatic native language switching or SDK background push service. Monitor 401/429/5xx and SDK refresh outcomes. See [`sdks/README.md`](../sdks/README.md) for integration and formatting details and the Unicode license included with the SDKs.

Manager API: `GET/POST /api/projects/:id/releases`, `POST /releases/activate` (`release`, `channel`, `expectedHeadVersion`), `POST /delivery-keys` (`name`) and `DELETE /delivery-keys/:hash`. Publishing requires `label`, `channel` and `expectedHeadVersion` (0 for an empty channel). There are no writes on the `/ota/` delivery endpoint.
