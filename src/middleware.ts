import { defineMiddleware } from "astro:middleware";
import { authenticate, checkOrigin, HttpError } from "./server/auth";
import { config } from "./server/config";

export const onRequest = defineMiddleware(async (context, next) => {
  const path = context.url.pathname;
  let response: Response;
  try {
    // Assets contain no project data. The health check is used by Lambda Web Adapter.
    if (
      path.startsWith("/_astro/") ||
      path === "/favicon.svg" ||
      path === "/api/health"
    )
      return next();
    const samlPost =
      config().authMode === "saml" &&
      path === "/auth/saml/acs" &&
      context.request.method === "POST";
    const publicPath =
      path.startsWith("/sync/") ||
      path.startsWith("/scim/v2/") ||
      path.startsWith("/ota/") ||
      ["/tasks/snapshots", "/tasks/identities"].includes(path) ||
      path === "/mcp" ||
      samlPost ||
      path === "/auth/saml/metadata" ||
      path === "/login" ||
      path === "/auth/login" ||
      path === "/auth/callback" ||
      path === "/auth/setup" ||
      path === "/auth/install" ||
      path === "/api/auth/install" ||
      path === "/api/auth/login" ||
      path === "/api/auth/activate";
    // SAML's cross-site POST is bound to a one-time browser cookie, RelayState,
    // signed assertion, and request ID. MCP validates its own Host/Origin and
    // requires a dedicated bearer token. SCIM and maintenance jobs each use
    // separate bearer credentials; browser writes continue to check Origin.
    if (
      !samlPost &&
      !path.startsWith("/sync/") &&
      !path.startsWith("/scim/v2/") &&
      path !== "/mcp" &&
      !["/tasks/snapshots", "/tasks/identities"].includes(path) &&
      !["GET", "HEAD", "OPTIONS"].includes(context.request.method)
    )
      checkOrigin(context.request);
    if (!publicPath) {
      context.locals.identity = await authenticate(
        context.request,
        context.cookies,
      );
      if (!context.locals.identity) {
        response = path.startsWith("/api/")
          ? Response.json({ error: "Sign in to continue." }, { status: 401 })
          : context.redirect("/login");
      } else if (
        context.locals.identity.tokenProject &&
        !(
          context.request.method === "GET" &&
          /^\/api\/projects\/[^/]+\/export$/.test(path)
        )
      ) {
        response = Response.json(
          { error: "Export tokens can only read their project export." },
          { status: 403 },
        );
      } else response = await next();
    } else response = await next();
  } catch (error) {
    if (!(error instanceof HttpError))
      console.error(
        "Request failed:",
        error instanceof Error ? error.message : "Unknown error",
      );
    response = Response.json(
      {
        error:
          error instanceof HttpError
            ? error.message
            : "Something went wrong. Please try again.",
      },
      { status: error instanceof HttpError ? error.status : 500 },
    );
  }
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "same-origin");
  if (
    path.startsWith("/auth/") ||
    path.startsWith("/api/auth/") ||
    path === "/login"
  )
    response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()",
  );
  if (!(path.startsWith("/ota/") && [200, 304].includes(response.status)))
    response.headers.set("Cache-Control", "no-store");
  if (config().production)
    response.headers.set(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
  return response;
});
