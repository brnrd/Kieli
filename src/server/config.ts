import type { AuthMode } from "../shared";

export function config() {
  const production = process.env.NODE_ENV === "production";
  const authMode = process.env.AUTH_MODE ?? (production ? "okta" : "demo");
  if (!["demo", "okta", "local", "saml"].includes(authMode))
    throw new Error("AUTH_MODE must be demo, local, okta, or saml");
  if (authMode === "demo" && production)
    throw new Error("Demo authentication is forbidden in production");
  const origin =
    process.env.APP_ORIGIN ?? (production ? "" : "http://localhost:4321");
  if (!origin || new URL(origin).origin !== origin)
    throw new Error("APP_ORIGIN must be an exact origin");
  if (
    (production || authMode === "okta" || authMode === "saml") &&
    new URL(origin).protocol !== "https:"
  )
    throw new Error("Production and SSO require an HTTPS APP_ORIGIN");
  if (
    authMode === "local" &&
    !production &&
    new URL(origin).protocol !== "https:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname)
  )
    throw new Error(
      "Local HTTP authentication is restricted to loopback. Configure HTTPS to expose it.",
    );
  const driver =
    process.env.STORAGE_DRIVER ?? (production ? "dynamodb" : "sqlite");
  if (!["sqlite", "dynamodb"].includes(driver))
    throw new Error("Invalid STORAGE_DRIVER");
  return {
    production,
    authMode: authMode as AuthMode,
    origin,
    driver,
  };
}
export function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required configuration: ${name}`);
  return value;
}
