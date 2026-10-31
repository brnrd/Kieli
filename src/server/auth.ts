import { createHash, randomBytes } from "node:crypto";
import { EncryptJWT, jwtDecrypt } from "jose";
import * as oidc from "openid-client";
import type { AstroCookies } from "astro";
import type { Identity, Role, Token } from "../shared";
import { config, required } from "./config";
import { getStore } from "./store";
import { sessions, sessionCookieOptions } from "./sessions";
import { HttpError } from "./errors";
export { HttpError } from "./errors";

export const hashToken = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function projectRole(identity: Identity, id: string): Role | undefined {
  if (identity.admin) return "admin";
  const role = Object.hasOwn(identity.projects, id)
    ? identity.projects[id]
    : undefined;
  return role && ["admin", "manager", "user"].includes(role) ? role : undefined;
}
export function authorize(
  identity: Identity,
  projectId: string,
  minimum: Role = "user",
) {
  const role = projectRole(identity, projectId);
  const ranks = { user: 0, manager: 1, admin: 2 };
  if (!role || ranks[role] < ranks[minimum])
    throw new HttpError(403, "You do not have access to this action.");
  return role;
}
export function identityFromClaims(claims: Record<string, unknown>): Identity {
  if (typeof claims.sub !== "string")
    throw new HttpError(401, "Invalid identity.");
  const groups = Array.isArray(claims.groups)
    ? claims.groups.filter((g): g is string => typeof g === "string")
    : [];
  const projects: Record<string, Role> = Object.create(null);
  const ranks = { user: 0, manager: 1, admin: 2 };
  for (const group of groups) {
    const match = /^keylo:([a-z0-9][a-z0-9-]{0,47}):(admin|manager|user)$/.exec(
      group,
    );
    if (match) {
      const id = match[1]!;
      const role = match[2] as Role;
      if (!projects[id] || ranks[role] > ranks[projects[id]!])
        projects[id] = role;
    }
  }
  return {
    sub: claims.sub,
    name: String(claims.name ?? claims.email ?? "Team member"),
    email: String(claims.email ?? ""),
    admin: groups.includes("keylo-admin"),
    projects,
  };
}
const demoIdentity: Identity = {
  sub: "local-developer",
  name: "Alex Morgan",
  email: "alex@keylo.local",
  admin: true,
  projects: {},
  demo: true,
};
function cookieOptions() {
  return sessionCookieOptions();
}
function sessionKey() {
  const value = required("SESSION_SECRET");
  if (!/^[a-f0-9]{64}$/i.test(value))
    throw new Error(
      "SESSION_SECRET must be 32 random bytes encoded as 64 hex characters",
    );
  return Buffer.from(value, "hex");
}
export async function seal(
  payload: Record<string, unknown>,
  lifetime: number,
  purpose: string,
) {
  return new EncryptJWT(payload)
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuedAt()
    .setIssuer("keylo")
    .setAudience(purpose)
    .setExpirationTime(Math.floor(Date.now() / 1000) + lifetime)
    .encrypt(sessionKey());
}
async function unseal(value: string, purpose: string) {
  return (
    await jwtDecrypt(value, sessionKey(), {
      issuer: "keylo",
      audience: purpose,
    })
  ).payload;
}
export async function authenticate(
  request: Request,
  cookies: AstroCookies,
): Promise<Identity | undefined> {
  const { authMode } = config();
  if (authMode === "demo") {
    if (
      !["localhost", "127.0.0.1", "[::1]"].includes(
        new URL(request.url).hostname,
      )
    )
      throw new HttpError(403, "Demo mode is restricted to loopback.");
  }
  const authorization = request.headers.get("authorization");
  if (authorization) {
    const match =
      /^Bearer (keylo_([a-z0-9][a-z0-9-]{0,47})\.[a-f0-9]{64})$/.exec(
        authorization,
      );
    if (!match) throw new HttpError(401, "Invalid export token.");
    const projectId = match[2]!;
    const token = await (
      await getStore()
    ).get<Token>(`PROJECT#${projectId}`, `TOKEN#${hashToken(match[1]!)}`);
    if (!token || new Date(token.expiresAt).getTime() <= Date.now())
      throw new HttpError(401, "Export token expired or revoked.");
    return {
      sub: `token:${token.prefix}`,
      name: token.name,
      email: "",
      admin: false,
      projects: { [projectId]: "user" },
      tokenProject: projectId,
    };
  }
  if (authMode === "demo") return demoIdentity;
  return (await sessions()).resolve(cookies);
}
let oidcConfig: Promise<oidc.Configuration> | undefined;
function getOidc() {
  return (oidcConfig ??= oidc.discovery(
    new URL(required("OKTA_ISSUER")),
    required("OKTA_CLIENT_ID"),
    required("OKTA_CLIENT_SECRET"),
  ));
}
export async function beginLogin(cookies: AstroCookies) {
  if (config().authMode !== "okta")
    throw new HttpError(404, "Okta sign-in is not enabled.");
  const verifier = oidc.randomPKCECodeVerifier();
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  cookies.set(
    "keylo_login",
    await seal({ verifier, state, nonce }, 600, "login"),
    { ...cookieOptions(), maxAge: 600 },
  );
  return oidc.buildAuthorizationUrl(await getOidc(), {
    redirect_uri: `${config().origin}/auth/callback`,
    scope: process.env.OKTA_SCOPES ?? "openid profile email groups",
    state,
    nonce,
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
    code_challenge_method: "S256",
  }).href;
}
export async function finishLogin(request: Request, cookies: AstroCookies) {
  if (config().authMode !== "okta")
    throw new HttpError(404, "Okta sign-in is not enabled.");
  const value = cookies.get("keylo_login")?.value;
  cookies.delete("keylo_login", { path: "/" });
  if (!value)
    throw new HttpError(401, "Your sign-in expired. Please try again.");
  const login = await unseal(value, "login");
  const currentUrl = new URL("/auth/callback", config().origin);
  currentUrl.search = new URL(request.url).search;
  const tokens = await oidc.authorizationCodeGrant(
    await getOidc(),
    currentUrl,
    {
      pkceCodeVerifier: String(login.verifier),
      expectedState: String(login.state),
      expectedNonce: String(login.nonce),
      idTokenExpected: true,
    },
  );
  const claims = tokens.claims();
  if (!claims) throw new HttpError(401, "Okta did not return an identity.");
  const identity = {
    ...identityFromClaims(claims),
    provider: "okta" as const,
    issuer: String(claims.iss),
    subject: String(claims.sub),
  };
  const maxAge = Math.min(
    3600,
    Math.max(1, Number(claims.exp) - Math.floor(Date.now() / 1000)),
  );
  await (await sessions()).create(cookies, { identity, maxAge });
}
export async function logout(cookies: AstroCookies) {
  await (await sessions()).revoke(cookies);
}
export function generateToken(projectId: string) {
  return `keylo_${projectId}.${randomBytes(32).toString("hex")}`;
}
export function checkOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const expected = config().origin;
  const requestUrl = new URL(request.url);
  const loopback = ["localhost", "127.0.0.1", "[::1]"];
  let local = false;
  if (config().authMode === "demo" && !config().production && origin) {
    try {
      const supplied = new URL(origin);
      local =
        origin === supplied.origin &&
        supplied.protocol === "http:" &&
        requestUrl.protocol === "http:" &&
        loopback.includes(requestUrl.hostname) &&
        loopback.includes(supplied.hostname) &&
        supplied.port === requestUrl.port;
    } catch {
      /* Invalid origins fail the exact check below. */
    }
  }
  if (origin !== expected && !local)
    throw new HttpError(
      403,
      "Invalid request origin. Open Keylo at its configured APP_ORIGIN.",
    );
}
