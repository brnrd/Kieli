# Further Lambda backend separation — plan only

## Current implementation

Kieli already runs its frontend and backend on AWS Lambda. The ZIP installer uses Node.js 24, Lambda Web Adapter and API Gateway HTTP API, with DynamoDB storage. The scheduled maintenance runner is a second Lambda that invokes authenticated maintenance endpoints on the app. Docker is optional: the older SAM image template uses it; the ZIP installer and [Terraform example](../infra/terraform/README.md) do not.

The Terraform example is implemented. The changes below are proposed and have not been implemented. Splitting functions is not necessary to remove Docker.

## Recommended next step

Keep the single application Lambda initially. Measure cold starts, latency, memory and DynamoDB work for representative imports, exports, MCP requests and large projects. Capture baseline deployment/restore and auth lifecycle checks in a disposable AWS environment. The existing server/service boundary should remain; no function per CRUD operation and no SaaS tenancy.

If isolation or request duration warrants a split, implement in this order:

1. **Extract maintenance first.** Give a direct scheduled handler access to existing snapshot, cleanup and identity-reconciliation services. Remove the internal HTTP invocation and shared maintenance bearer secret only after both maintenance paths have equivalent tests. Give its IAM role only the required table/secret actions; preserve bounded work, continuation state, retry behavior and audit events. Deployment must switch schedules without duplicate concurrent jobs.
2. **Separate the HTTP backend from Astro rendering.** Introduce one API Lambda for `/api/*`, `/sync/*`, `/mcp`, `/scim/*`, `/ota/*` and maintenance-independent integration routes. Keep authentication callbacks and frontend routing under the same HTTPS origin. Decide whether `/auth/*` belongs to the API or rendering function before moving any routes. Share request authentication, session cookies, CSRF/origin checks, security headers and error handling; Lambda/API Gateway routing is not authorization. Keep business rules in the existing services and use the existing DynamoDB transaction/version conditions.
3. **Keep the frontend server initially.** Astro pages currently depend on server-side bootstrap/authentication. Moving static assets to private S3/CloudFront is a later optimization, with immutable caching, invalidation and same-origin routing specified separately. Do not assume the current Astro app is a static build.
4. **Handle genuinely long work separately when measured.** Consider asynchronous export/import/snapshot jobs only if synchronous limits are reached. Specify per-job ownership, bounded inputs, retries/idempotency, progress, cancellation, artifact expiry, authorized downloads and failure recovery before adding a queue or bucket. Keep existing CLI/API behavior until a deliberate contract change is accepted.

## Acceptance before enabling a split

- Preserve local SQLite development and shared service tests. Native HTTP/event adapters stay thin and do not duplicate role checks.
- Exercise local, OIDC and SAML sign-in/logout/SLO, SCIM offboarding, revocable sessions and every integration credential's boundaries across the routed functions. Never identify or merge users by email.
- Verify API Gateway binary ZIP responses, cookies, SAML cross-site forms, MCP transport behavior, encoded paths, errors, payload/time limits and security headers using real deployed endpoints. Keep the external origin stable.
- Test concurrent writes and scheduled jobs against DynamoDB, backup restoration and rollback. Keep one authoritative table; no data-copy migration should be needed for function separation.
- Provide function-specific logs, failure alarms, concurrency limits and scoped IAM. Compare measured latency/cost and code/package size with the baseline. No claim of production readiness from local fixtures.
- Update the shared installer first, then regenerate the Terraform wrapper's template. Avoid maintaining separate CloudFormation and native Terraform architectures until there is a concrete need.

This is the second phase for review, not authorization to deploy or implement it automatically.
