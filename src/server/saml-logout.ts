import { randomBytes, randomUUID } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { SAML, ValidateInResponseTo, type Profile } from "@node-saml/node-saml";
import type { AstroCookies } from "astro";
import { config } from "./config";
import { digest } from "./local-auth";
import { HttpError } from "./errors";
import { readBody } from "./http";
import { Conflict, getStore, type Store, type Change } from "./store";
import { SamlCache } from "./saml-cache";
import {
  persistentNameID,
  samlSettings,
  type SamlSettings,
} from "./saml-config";
import {
  parseSamlXml,
  children,
  one,
  text,
  timestamp,
  signatureAlgorithms,
} from "./saml-xml";
import {
  samlRevocationKey,
  type SamlRevocation,
  type SamlSession,
} from "./saml-session";

export const samlLogoutCookie = "__Secure-kieli_saml_logout";
const cookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: "none" as const,
  path: "/auth/saml",
  maxAge: 600,
};
const token = /^[a-f0-9]{64}$/;
const protocol = "urn:oasis:names:tc:SAML:2.0:protocol";
const assertion = "urn:oasis:names:tc:SAML:2.0:assertion";
const ds = "http://www.w3.org/2000/09/xmldsig#";
const invalid = () => {
  throw new HttpError(401, "SAML logout could not be verified.");
};
type Flow = {
  version: number;
  requestId: string;
  browserHash: string;
  ttl: number;
};

// Reject malformed/ambiguous messages before authentication. Node-SAML still verifies
// the pinned IdP signature; these checks never authenticate a message themselves.
export function logoutEnvelope(
  encoded: string,
  redirect: boolean,
  settings: SamlSettings,
) {
  if (
    !encoded ||
    encoded.length > 350000 ||
    encoded.length % 4 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
  )
    invalid();
  const bytes = Buffer.from(encoded, "base64");
  const xml = new TextDecoder("utf-8", { fatal: true }).decode(
    redirect ? inflateRawSync(bytes, { maxOutputLength: 262144 }) : bytes,
  );
  if (Buffer.byteLength(xml) > 262144) invalid();
  const root = parseSamlXml(xml);
  const request = root.localName === "LogoutRequest";
  if (
    (!request && root.localName !== "LogoutResponse") ||
    root.namespaceURI !== protocol ||
    root.getAttribute("Version") !== "2.0" ||
    root.getAttribute("Destination") !== settings.logoutCallbackUrl
  )
    invalid();
  const id = root.getAttribute("ID");
  if (!id || !/^[_a-zA-Z][_a-zA-Z0-9.-]{0,199}$/.test(id)) invalid();
  const ids = new Set<string>();
  for (const element of [root, ...Array.from(root.getElementsByTagName("*"))]) {
    if (element.hasAttribute("ID")) {
      const value = element.getAttribute("ID")!;
      if (ids.has(value)) invalid();
      ids.add(value);
    }
  }
  const issued = timestamp(root.getAttribute("IssueInstant"));
  if (issued < Date.now() - 300000 || issued > Date.now() + 60000) invalid();
  if (text(one(root, "Issuer"), 1024) !== settings.idpIssuer) invalid();
  const expires = root.getAttribute("NotOnOrAfter");
  if (expires && timestamp(expires) <= Date.now()) invalid();
  const signatures = children(root, "Signature", ds);
  if (redirect) {
    if (root.getElementsByTagNameNS(ds, "Signature").length) invalid();
  } else {
    if (signatures.length !== 1) invalid();
    signatureAlgorithms(root, 1);
    const reference = one(
      one(signatures[0]!, "SignedInfo", ds),
      "Reference",
      ds,
    );
    if (reference.getAttribute("URI") !== `#${id}`) invalid();
  }
  for (const child of Array.from(root.childNodes).filter(
    (node): node is Element => node.nodeType === 1,
  )) {
    if (!(
      (child.namespaceURI === assertion &&
        ["Issuer", ...(request ? ["NameID"] : [])].includes(
          child.localName!,
        )) ||
      (child.namespaceURI === protocol &&
        (request
          ? child.localName === "SessionIndex"
          : child.localName === "Status")) ||
      (child.namespaceURI === ds && child.localName === "Signature")
    ))
      invalid();
  }
  if (!request) {
    const inResponseTo = root.getAttribute("InResponseTo");
    if (!inResponseTo || inResponseTo.length > 200) invalid();
    const status = one(one(root, "Status", protocol), "StatusCode", protocol);
    if (
      status.getAttribute("Value") !==
        `${protocol.replace(/protocol$/, "status")}:Success` ||
      children(status, "StatusCode", protocol).length
    )
      invalid();
    return { request: false as const, id: id!, inResponseTo: inResponseTo! };
  }
  if (root.hasAttribute("InResponseTo")) invalid();
  const name = one(root, "NameID");
  const nameID = text(name, 256);
  if (!nameID.trim() || name.getAttribute("Format") !== persistentNameID)
    invalid();
  for (const [attribute, expected] of [
    ["NameQualifier", settings.idpIssuer],
    ["SPNameQualifier", settings.entityId],
  ])
    if (
      name.hasAttribute(attribute!) &&
      name.getAttribute(attribute!) !== expected
    )
      invalid();
  const indexes = children(root, "SessionIndex", protocol).map((node) =>
    text(node, 1024),
  );
  if (
    indexes.length > 20 ||
    indexes.some((value) => !value.trim()) ||
    new Set(indexes).size !== indexes.length
  )
    invalid();
  return { request: true as const, id: id!, nameID, indexes };
}

export class SamlLogout {
  private scope: string;
  constructor(
    private store: Store,
    private settings: SamlSettings,
  ) {
    this.scope = JSON.stringify([
      "logout",
      settings.idpIssuer,
      settings.entityId,
      settings.logoutUrl,
      settings.logoutCallbackUrl,
    ]);
  }
  private enabled() {
    if (
      config().authMode !== "saml" ||
      !this.settings.logoutUrl ||
      !this.settings.logoutCallbackUrl
    )
      throw new HttpError(404, "SAML Single Logout is not configured.");
  }
  private client(requestId?: string) {
    return new SAML({
      entryPoint: this.settings.entryPoint,
      issuer: this.settings.entityId,
      callbackUrl: this.settings.callbackUrl,
      logoutUrl: this.settings.logoutUrl,
      logoutCallbackUrl: this.settings.logoutCallbackUrl,
      idpIssuer: this.settings.idpIssuer,
      idpCert: this.settings.idpCert,
      privateKey: this.settings.privateKey,
      publicCert: this.settings.publicCert,
      signatureAlgorithm: "sha256",
      digestAlgorithm: "sha256",
      wantAuthnResponseSigned: true,
      validateInResponseTo: ValidateInResponseTo.always,
      cacheProvider: new SamlCache(this.store, this.scope, requestId),
      ...(requestId ? { generateUniqueId: () => requestId } : {}),
    });
  }
  private flowKey(relay: string) {
    return `SAML_LOGOUT_FLOW#${digest(this.scope)}#${digest(relay)}`;
  }
  private audit(action: string, actor = "anonymous"): Change {
    const at = new Date().toISOString();
    return {
      pk: "AUTH_AUDIT",
      sk: `${at}#${randomUUID()}`,
      value: { version: 1, action, actor, provider: "saml", at },
    };
  }
  async begin(session: SamlSession | undefined, cookies: AstroCookies) {
    this.enabled();
    if (!session || session.issuer !== this.settings.idpIssuer) invalid();
    const relay = randomBytes(32).toString("hex"),
      browser = randomBytes(32).toString("hex");
    const requestId = `_${randomBytes(24).toString("hex")}`;
    const url = await this.client(requestId).getLogoutUrlAsync(
      session as Profile,
      relay,
      {},
    );
    const key = samlRevocationKey(
      session!.issuer,
      session!.nameID,
      session!.sessionIndex,
    );
    const before = Date.now();
    for (let attempt = 0; attempt < 8; attempt++) {
      const old = await this.store.get<SamlRevocation>(key, "META");
      try {
        await this.store.transact([
          {
            pk: this.flowKey(relay),
            sk: "META",
            value: {
              version: 1,
              requestId,
              browserHash: digest(browser),
              ttl: Math.floor(Date.now() / 1000) + 600,
            },
          },
          {
            pk: key,
            sk: "META",
            expectedVersion: old?.version,
            value: {
              version: (old?.version ?? 0) + 1,
              before: Math.max(before, old?.before ?? 0),
              ttl: Math.floor(before / 1000) + 7200,
            },
          },
          this.audit(
            "logout.saml_started",
            `saml:${digest(JSON.stringify([session!.issuer, session!.nameID]))}`,
          ),
        ]);
        break;
      } catch (error) {
        if (!(error instanceof Conflict) || attempt === 7) throw error;
      }
    }
    cookies.set(samlLogoutCookie, browser, cookieOptions);
    return url;
  }
  async receive(request: Request, cookies: AstroCookies) {
    this.enabled();
    try {
      const redirect = request.method === "GET";
      let raw: string;
      if (redirect) {
        raw = new URL(request.url).search.slice(1);
        if (raw.length > 350000)
          throw new HttpError(413, "SAML logout message is too large.");
      } else {
        if (
          request.headers
            .get("content-type")
            ?.split(";")[0]
            ?.trim()
            .toLowerCase() !== "application/x-www-form-urlencoded"
        )
          throw new HttpError(415, "SAML requires a form-encoded POST.");
        raw = (await readBody(request, 350000)).toString("utf8");
      }
      const fields = new URLSearchParams(raw);
      const allowed = redirect
        ? ["SAMLRequest", "SAMLResponse", "RelayState", "SigAlg", "Signature"]
        : ["SAMLRequest", "SAMLResponse", "RelayState"];
      for (const key of fields.keys())
        if (!allowed.includes(key) || fields.getAll(key).length !== 1)
          invalid();
      if (fields.has("SAMLRequest") === fields.has("SAMLResponse")) invalid();
      const relay = fields.get("RelayState") ?? "";
      if (Buffer.byteLength(relay) > 80) invalid();
      if (
        redirect &&
        ![
          "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
          "http://www.w3.org/2001/04/xmldsig-more#rsa-sha512",
        ].includes(fields.get("SigAlg") ?? "")
      )
        invalid();
      const envelope = logoutEnvelope(
        fields.get(fields.has("SAMLRequest") ? "SAMLRequest" : "SAMLResponse")!,
        redirect,
        this.settings,
      );
      let flow: Flow | undefined;
      if (!envelope.request) {
        const browser = cookies.get(samlLogoutCookie)?.value;
        if (!token.test(relay) || !browser || !token.test(browser)) invalid();
        flow = await this.store.get<Flow>(this.flowKey(relay), "META");
        if (
          !flow ||
          flow.ttl <= Date.now() / 1000 ||
          flow.requestId !== envelope.inResponseTo ||
          flow.browserHash !== digest(browser!)
        )
          invalid();
      }
      const client = this.client(flow?.requestId);
      const result = redirect
        ? await client.validateRedirectAsync(raw)
        : envelope.request
          ? await client.validatePostRequestAsync({
              SAMLRequest: fields.get("SAMLRequest")!,
            })
          : await client.validatePostResponseAsync({
              SAMLResponse: fields.get("SAMLResponse")!,
            });
      if (
        !result.loggedOut ||
        (envelope.request ? !result.profile : result.profile)
      )
        invalid();
      if (!envelope.request) {
        await this.store.transact([
          {
            pk: this.flowKey(relay),
            sk: "META",
            expectedVersion: flow!.version,
          },
          this.audit("logout.saml_succeeded"),
        ]);
        cookies.delete(samlLogoutCookie, cookieOptions);
        return { location: "/login?logout=saml" };
      }
      // Authenticate before writing revocations. A shared transaction makes the request
      // one-time and publishes all SessionIndex tombstones together, even across Lambdas.
      const replay = `SAML_LOGOUT_REPLAY#${digest(this.scope)}#${digest(envelope.id)}`;
      const before = Date.now(),
        ttl = Math.floor(before / 1000) + 7200;
      for (let attempt = 0; attempt < 8; attempt++) {
        const previous = await this.store.get<{ version: number; ttl: number }>(
          replay,
          "META",
        );
        if (previous && previous.ttl > Date.now() / 1000) invalid();
        const keys = (
          envelope.indexes.length ? envelope.indexes : [undefined]
        ).map((index) =>
          samlRevocationKey(this.settings.idpIssuer, envelope.nameID, index),
        );
        const records = await Promise.all(
          keys.map((key) => this.store.get<SamlRevocation>(key, "META")),
        );
        try {
          await this.store.transact([
            {
              pk: replay,
              sk: "META",
              expectedVersion: previous?.version,
              value: { version: (previous?.version ?? 0) + 1, ttl },
            },
            ...keys.map((pk, index) => ({
              pk,
              sk: "META",
              expectedVersion: records[index]?.version,
              value: {
                version: (records[index]?.version ?? 0) + 1,
                before: Math.max(before, records[index]?.before ?? 0),
                ttl,
              },
            })),
            this.audit(
              "logout.saml_idp_revoked",
              `saml:${digest(JSON.stringify([this.settings.idpIssuer, envelope.nameID]))}`,
            ),
          ]);
          break;
        } catch (error) {
          if (!(error instanceof Conflict) || attempt === 7) throw error;
        }
      }
      return {
        location: await this.client().getLogoutResponseUrlAsync(
          result.profile!,
          relay,
          {},
          true,
        ),
      };
    } catch (error) {
      const event = this.audit("logout.saml_failed");
      await this.store.put(event.pk, event.sk, event.value!);
      if (
        error instanceof HttpError &&
        [400, 413, 415, 404].includes(error.status)
      )
        throw error;
      throw new HttpError(401, "SAML logout could not be verified.");
    }
  }
}
export async function samlLogout() {
  return new SamlLogout(await getStore(), await samlSettings());
}
