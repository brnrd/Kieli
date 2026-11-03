import { randomBytes } from "node:crypto";
import type { AstroCookies } from "astro";
import type { Identity, IdentityProvider } from "../shared";
import { config } from "./config";
import { digest, LocalAuth, type LocalUser, userIdentity } from "./local-auth";
import { SsoDirectory } from "./sso-directory";
import { HttpError } from "./errors";
import { Conflict, getStore, type Store } from "./store";

import { samlSessionRevoked, type SamlSession } from "./saml-session";

export const sessionCookie = "kieli_session";
type Session = {
  version: number;
  saml?: SamlSession;
  provider: IdentityProvider;
  userId?: string;
  authVersion?: number;
  identity?: Identity;
  authTime: number;
  lastSeen: number;
  ttl: number;
};
const seconds = () => Math.floor(Date.now() / 1000);
export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: new URL(config().origin).protocol === "https:",
    sameSite: "lax" as const,
    path: "/",
  };
}
export class Sessions {
  constructor(private store: Store) {}
  async create(
    cookies: AstroCookies,
    source:
      | { user: LocalUser }
      | { identity: Identity; maxAge: number; saml?: SamlSession },
  ) {
    const secret = randomBytes(32).toString("hex");
    const at = seconds();
    const provider =
      "user" in source
        ? "local"
        : source.identity.provider === "saml"
          ? "saml"
          : "okta";
    if (provider !== config().authMode)
      throw new Error("Session provider does not match authentication mode.");
    const maxAge =
      "user" in source ? 28800 : Math.min(Math.floor(source.maxAge), 3600);
    if (!Number.isFinite(maxAge) || maxAge <= 0)
      throw new Error("Invalid session lifetime.");
    const principal =
      "identity" in source
        ? await new SsoDirectory(this.store).login(source.identity)
        : undefined;
    const session: Session = {
      version: 1,
      ...("saml" in source && source.saml ? { saml: source.saml } : {}),
      authTime: at,
      lastSeen: at,
      ttl: at + maxAge,
      ...("user" in source
        ? {
            provider: "local" as const,
            userId: source.user.id,
            authVersion: source.user.authVersion,
          }
        : {
            provider,
            identity: { ...principal!.identity, provider },
            authVersion: principal!.user.authVersion,
          }),
    };
    if (session.saml && (await samlSessionRevoked(this.store, session.saml)))
      throw new HttpError(
        401,
        "This SAML session has been signed out. Sign in again.",
      );
    await this.revoke(cookies);
    await this.store.put(`SESSION#${digest(secret)}`, "META", session);
    cookies.set(sessionCookie, secret, { ...sessionCookieOptions(), maxAge });
  }
  async resolve(cookies: AstroCookies): Promise<Identity | undefined> {
    const secret = cookies.get(sessionCookie)?.value;
    if (!secret) return undefined;
    const clear = () => {
      cookies.delete(sessionCookie, { path: "/" });
      return undefined;
    };
    if (!/^[a-f0-9]{64}$/.test(secret)) return clear();
    const pk = `SESSION#${digest(secret)}`;
    const session = await this.store.get<Session>(pk, "META");
    if (
      !session ||
      session.provider !== config().authMode ||
      session.ttl <= seconds() ||
      seconds() - session.lastSeen >= 1800
    )
      return clear();
    if (
      session.provider === "saml" &&
      ((process.env.SAML_LOGOUT_URL && !session.saml) ||
        (session.saml && (await samlSessionRevoked(this.store, session.saml))))
    )
      return clear();
    let identity: Identity;
    if (session.provider === "local") {
      const user = session.userId
        ? await new LocalAuth(this.store).getUser(session.userId)
        : undefined;
      if (
        !user ||
        user.status !== "active" ||
        user.authVersion !== session.authVersion
      )
        return clear();
      identity = userIdentity(user, session.authTime);
    } else {
      if (!session.identity?.principalId || session.authVersion === undefined)
        return clear();
      try {
        identity = {
          ...(await new SsoDirectory(this.store).resolve(
            session.identity.principalId,
            session.authVersion,
            session.authTime,
          )),
          sessionExpiresAt: session.ttl,
        };
      } catch (error) {
        if (error instanceof HttpError && error.status === 401) return clear();
        throw error;
      }
    }
    if (seconds() - session.lastSeen >= 300) {
      try {
        await this.store.put(
          pk,
          "META",
          { ...session, lastSeen: seconds(), version: session.version + 1 },
          session.version,
        );
      } catch (error) {
        if (!(error instanceof Conflict)) throw error;
        // A concurrent logout must never re-create the session during a touch.
        if (!(await this.store.get<Session>(pk, "META"))) return clear();
      }
    }
    return identity;
  }
  async endForSamlLogout(
    cookies: AstroCookies,
  ): Promise<SamlSession | undefined> {
    const secret = cookies.get(sessionCookie)?.value;
    try {
      if (!secret || !/^[a-f0-9]{64}$/.test(secret)) return;
      const session = await this.store.get<Session>(
        `SESSION#${digest(secret)}`,
        "META",
      );
      if (
        session?.provider === "saml" &&
        session.ttl > seconds() &&
        seconds() - session.lastSeen < 1800
      )
        return session.saml;
    } finally {
      await this.revoke(cookies);
    }
  }
  async revoke(cookies: AstroCookies) {
    const secret = cookies.get(sessionCookie)?.value;
    if (secret && /^[a-f0-9]{64}$/.test(secret)) {
      await this.revokeHash(digest(secret));
    }
    cookies.delete(sessionCookie, { path: "/" });
  }
  async revokeHash(hash: string) {
    if (/^[a-f0-9]{64}$/.test(hash)) {
      const pk = `SESSION#${hash}`;
      // Touches can race a sign-out. Retry conditional deletion without re-creating a row.
      for (let attempt = 0; attempt < 8; attempt++) {
        const session = await this.store.get<Session>(pk, "META");
        if (!session) break;
        try {
          await this.store.remove(pk, "META", session.version);
          break;
        } catch (error) {
          if (!(error instanceof Conflict) || attempt === 7) throw error;
        }
      }
    }
  }
}
export async function sessions() {
  return new Sessions(await getStore());
}
