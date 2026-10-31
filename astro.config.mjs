import { defineConfig } from "astro/config";
import node from "@astrojs/node";
import react from "@astrojs/react";

export default defineConfig({
  output: "server",
  session: false,
  markdown: { syntaxHighlight: false },
  adapter: node({ mode: "standalone" }),
  integrations: [react()],
  security: {
    // Middleware enforces exact APP_ORIGIN on unsafe requests, with a narrowly
    // scoped exceptions for the signed SAML callback and bearer-only MCP endpoint.
    checkOrigin: false,
    csp: {
      directives: [
        "default-src 'self'",
        "connect-src 'self'",
        "img-src 'self' data:",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ],
    },
  },
  server: { host: "127.0.0.1", port: 4321 },
  vite: { ssr: { external: ["node:sqlite", "@node-rs/argon2"] } },
});
