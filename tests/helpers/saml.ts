import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { SignedXml } from "xml-crypto";
import type { AstroCookies } from "astro";
import {
  persistentNameID,
  type SamlSettings,
} from "../../src/server/saml-config";

// Generated only in disposable test directories. Never use these keys in a deployment.
export async function samlFixture(origin = "https://copy.example.com") {
  const directory = await mkdtemp(join(tmpdir(), "keylo-saml-test-"));
  async function pair(name: string) {
    const key = join(directory, `${name}.key`),
      cert = join(directory, `${name}.crt`);
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        key,
        "-out",
        cert,
        "-days",
        "2",
        "-subj",
        `/CN=Keylo ${name} TEST ONLY`,
      ],
      { stdio: "ignore" },
    );
    return {
      key: await readFile(key, "utf8"),
      cert: await readFile(cert, "utf8"),
    };
  }
  const idp = await pair("idp"),
    sp = await pair("sp");
  const settings: SamlSettings = {
    entryPoint: "https://idp.example.com/sso",
    idpIssuer: "https://idp.example.com/issuer",
    entityId: `${origin}/auth/saml/metadata`,
    callbackUrl: `${origin}/auth/saml/acs`,
    idpCert: [idp.cert],
    privateKey: sp.key,
    publicCert: sp.cert,
  };
  return {
    idp,
    sp,
    settings,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}
export function cookieJar(initial: Iterable<[string, string]> = []) {
  const values = new Map(initial);
  const options: Record<string, Record<string, unknown>> = {};
  const cookies = {
    get: (name: string) =>
      values.has(name) ? { value: values.get(name) } : undefined,
    set: (name: string, value: string, settings: Record<string, unknown>) => {
      values.set(name, value);
      options[name] = settings;
    },
    delete: (name: string) => {
      values.delete(name);
    },
  } as unknown as AstroCookies;
  return { values, options, cookies };
}
export function requestInfo(url: string) {
  const parsed = new URL(url);
  const xml = inflateRawSync(
    Buffer.from(parsed.searchParams.get("SAMLRequest")!, "base64"),
  ).toString();
  return {
    xml,
    id: /<samlp:AuthnRequest\b[^>]*\bID="([^"]+)"/.exec(xml)![1]!,
    relay: parsed.searchParams.get("RelayState")!,
  };
}
export const escapeXml = (value: string) =>
  value.replace(
    /[<>&"']/g,
    (c) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;",
        "'": "&apos;",
      })[c]!,
  );
export function signedResponse(
  fixture: Awaited<ReturnType<typeof samlFixture>>,
  requestId: string,
  changes: Record<string, unknown> = {},
) {
  const at = Date.now(),
    iso = (offset: number) => new Date(at + offset).toISOString();
  const options = {
    responseIssuer: fixture.settings.idpIssuer,
    issuer: fixture.settings.idpIssuer,
    destination: fixture.settings.callbackUrl,
    recipient: fixture.settings.callbackUrl,
    audience: fixture.settings.entityId,
    subjectRequestId: requestId,
    responseRequestId: requestId,
    assertionId: `_${randomUUID()}`,
    subject: "immutable-user-123",
    nameIDFormat: persistentNameID,
    email: "alex@example.com",
    name: "Alex Morgan",
    groups: ["keylo:website:manager"],
    issued: iso(-1000),
    notBefore: iso(-60000),
    expires: iso(240000),
    authnInstant: iso(-2000),
    sessionExpires: iso(1800000),
    confirmationMethod: "urn:oasis:names:tc:SAML:2.0:cm:bearer",
    ...changes,
  };
  const value = (key: keyof typeof options) => escapeXml(String(options[key]));
  const attribute = (name: string, values: string[]) =>
    `<saml:Attribute Name="${name}">${values.map((v) => `<saml:AttributeValue>${escapeXml(v)}</saml:AttributeValue>`).join("")}</saml:Attribute>`;
  let xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_${randomUUID()}" Version="2.0" IssueInstant="${value("issued")}" Destination="${value("destination")}" InResponseTo="${value("responseRequestId")}"><saml:Issuer>${value("responseIssuer")}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status><saml:Assertion ID="${value("assertionId")}" Version="2.0" IssueInstant="${value("issued")}"><saml:Issuer>${value("issuer")}</saml:Issuer><saml:Subject><saml:NameID Format="${value("nameIDFormat")}">${value("subject")}</saml:NameID><saml:SubjectConfirmation Method="${value("confirmationMethod")}"><saml:SubjectConfirmationData Recipient="${value("recipient")}" InResponseTo="${value("subjectRequestId")}" NotOnOrAfter="${value("expires")}"/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${value("notBefore")}" NotOnOrAfter="${value("expires")}"><saml:AudienceRestriction><saml:Audience>${value("audience")}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AuthnStatement AuthnInstant="${value("authnInstant")}" SessionIndex="test-session" SessionNotOnOrAfter="${value("sessionExpires")}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement><saml:AttributeStatement>${attribute("name", [options.name])}${attribute("email", [options.email])}${attribute("groups", options.groups)}</saml:AttributeStatement></saml:Assertion></samlp:Response>`;
  const sign = (input: string, element: string) => {
    const signer = new SignedXml({
      privateKey: fixture.idp.key,
      publicCert: fixture.idp.cert,
      signatureAlgorithm: changes.sha1
        ? "http://www.w3.org/2000/09/xmldsig#rsa-sha1"
        : "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
      canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
    });
    signer.addReference({
      xpath: `//*[local-name()='${element}']`,
      transforms: [
        "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
        "http://www.w3.org/2001/10/xml-exc-c14n#",
      ],
      digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
    });
    signer.computeSignature(input, {
      location: {
        reference: `//*[local-name()='${element}']/*[local-name()='Issuer']`,
        action: "after",
      },
    });
    return signer.getSignedXml();
  };
  if (!changes.unsignedAssertion) xml = sign(xml, "Assertion");
  if (!changes.unsignedResponse) xml = sign(xml, "Response");
  if (changes.tamper) xml = xml.replace("Alex Morgan", "Mallory Modified");
  return {
    xml,
    encoded: Buffer.from(xml).toString("base64"),
    assertionId: options.assertionId,
  };
}
export function callbackRequest(
  encoded: string,
  relay: string,
  url = "https://copy.example.com/auth/saml/acs",
) {
  return new Request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: "https://idp.example.com",
    },
    body: new URLSearchParams({ SAMLResponse: encoded, RelayState: relay }),
  });
}
