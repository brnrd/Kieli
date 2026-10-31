import { randomBytes, randomUUID } from "node:crypto";
import { SAML, ValidateInResponseTo } from "@node-saml/node-saml";
import type { AstroCookies } from "astro";
import { config } from "./config";
import { HttpError } from "./errors";
import { readBody } from "./http";
import { digest } from "./local-auth";
import { Conflict, getStore, type Store } from "./store";
import { SamlCache } from "./saml-cache";
import {
  persistentNameID,
  samlSettings,
  type SamlSettings,
} from "./saml-config";
import { checkSamlEnvelope, samlIdentity } from "./saml-xml";
import { Sessions, sessionCookie } from "./sessions";

export const samlCookie = "__Secure-keylo_saml";
const cookiePath = "/auth/saml";
const tokenPattern = /^[a-f0-9]{64}$/;
type Flow = {
  version: number;
  requestId: string;
  browserHash: string;
  ttl: number;
  previousSessionHash?: string;
};
function failure() {
  return new HttpError(
    401,
    "SAML sign-in could not be completed. Start again from Keylo.",
  );
}
export class SamlAuth {
  private scope: string;
  constructor(
    private store: Store,
    private settings: SamlSettings,
  ) {
    this.scope = JSON.stringify([
      settings.idpIssuer,
      settings.entryPoint,
      settings.entityId,
      settings.callbackUrl,
    ]);
  }
  private enabled() {
    if (config().authMode !== "saml")
      throw new HttpError(404, "SAML sign-in is not enabled.");
  }
  private client(requestId?: string) {
    return new SAML({
      entryPoint: this.settings.entryPoint,
      issuer: this.settings.entityId,
      audience: this.settings.entityId,
      callbackUrl: this.settings.callbackUrl,
      idpIssuer: this.settings.idpIssuer,
      idpCert: this.settings.idpCert,
      privateKey: this.settings.privateKey,
      publicCert: this.settings.publicCert,
      signatureAlgorithm: "sha256",
      digestAlgorithm: "sha256",
      signMetadata: true,
      identifierFormat: persistentNameID,
      wantAssertionsSigned: true,
      wantAuthnResponseSigned: true,
      validateInResponseTo: ValidateInResponseTo.always,
      rejectReplayedAssertions: true,
      acceptedClockSkewMs: 60000,
      maxAssertionAgeMs: 300000,
      requestIdExpirationPeriodMs: 600000,
      cacheProvider: new SamlCache(this.store, this.scope, requestId),
      disableRequestedAuthnContext: true,
      ...(requestId ? { generateUniqueId: () => requestId } : {}),
    });
  }
  private flowKey(relay: string) {
    return `SAML_FLOW#${digest(this.scope)}#${digest(relay)}`;
  }
  private async audit(action: string, actor = "anonymous") {
    const at = new Date().toISOString();
    await this.store.put("AUTH_AUDIT", `${at}#${randomUUID()}`, {
      version: 1,
      action,
      actor,
      at,
      provider: "saml",
    });
  }
  async begin(cookies: AstroCookies) {
    this.enabled();
    const relay = randomBytes(32).toString("hex");
    const browser = randomBytes(32).toString("hex");
    const requestId = `_${randomBytes(24).toString("hex")}`;
    const url = await this.client(requestId).getAuthorizeUrlAsync(relay, {});
    const previous = cookies.get(sessionCookie)?.value;
    await this.store.put(this.flowKey(relay), "META", {
      version: 1,
      requestId,
      browserHash: digest(browser),
      ttl: Math.floor(Date.now() / 1000) + 600,
      ...(previous && tokenPattern.test(previous)
        ? { previousSessionHash: digest(previous) }
        : {}),
    });
    cookies.set(samlCookie, browser, {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      path: cookiePath,
      maxAge: 600,
    });
    return url;
  }
  metadata() {
    this.enabled();
    return this.client().generateServiceProviderMetadata(
      null,
      this.settings.publicCert,
    );
  }
  async finish(request: Request, cookies: AstroCookies) {
    this.enabled();
    const type = request.headers
      .get("content-type")
      ?.split(";")[0]
      ?.trim()
      .toLowerCase();
    if (type !== "application/x-www-form-urlencoded")
      throw new HttpError(415, "SAML requires a form-encoded POST.");
    const body = await readBody(request, 262144);
    const fields = new URLSearchParams(body.toString("utf8"));
    if (
      Array.from(fields.keys()).length !== 2 ||
      fields.getAll("SAMLResponse").length !== 1 ||
      fields.getAll("RelayState").length !== 1
    )
      throw new HttpError(400, "Invalid SAML form.");
    const browser = cookies.get(samlCookie)?.value;
    cookies.delete(samlCookie, {
      path: cookiePath,
      secure: true,
      sameSite: "none",
    });
    const relay = fields.get("RelayState")!;
    try {
      if (!browser || !tokenPattern.test(browser) || !tokenPattern.test(relay))
        throw failure();
      const pk = this.flowKey(relay);
      const flow = await this.store.get<Flow>(pk, "META");
      if (
        !flow ||
        flow.ttl <= Math.floor(Date.now() / 1000) ||
        flow.browserHash !== digest(browser)
      )
        throw failure();
      const encoded = fields.get("SAMLResponse")!;
      checkSamlEnvelope(encoded, flow.requestId, this.settings);
      const result = await this.client(
        flow.requestId,
      ).validatePostResponseAsync({ SAMLResponse: encoded });
      if (result.loggedOut || !result.profile) throw failure();
      const validated = samlIdentity(
        result.profile,
        flow.requestId,
        this.settings,
      );
      try {
        await this.store.remove(pk, "META", flow.version);
      } catch (error) {
        if (error instanceof Conflict) throw failure();
        throw error;
      }
      // The IdP's cross-site POST omits the main SameSite=Lax cookie. Revoke
      // the prior session captured at initiation before issuing its replacement.
      if (flow.previousSessionHash)
        await new Sessions(this.store).revokeHash(flow.previousSessionHash);
      await this.audit("login.saml_succeeded", validated.identity.sub);
      return validated;
    } catch {
      await this.audit("login.saml_failed");
      throw failure();
    }
  }
}
export async function samlAuth() {
  return new SamlAuth(await getStore(), await samlSettings());
}
