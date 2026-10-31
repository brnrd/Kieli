import { DOMParser } from "@xmldom/xmldom";
import type { Profile } from "@node-saml/node-saml";
import { identityFromClaims } from "./auth";
import { digest } from "./local-auth";
import { persistentNameID, type SamlSettings } from "./saml-config";

const assertionNS = "urn:oasis:names:tc:SAML:2.0:assertion";
const protocolNS = "urn:oasis:names:tc:SAML:2.0:protocol";
const ds = "http://www.w3.org/2000/09/xmldsig#";
const invalid = () => {
  throw new Error("Invalid SAML message.");
};
export function parseSamlXml(xml: string) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) return invalid();
  const root = new DOMParser({
    errorHandler: { warning: invalid, error: invalid, fatalError: invalid },
  }).parseFromString(xml, "text/xml").documentElement;
  if (!root) return invalid();
  return root;
}
export const children = (node: Element, name: string, ns = assertionNS) =>
  Array.from(node.childNodes).filter(
    (child): child is Element =>
      child.nodeType === 1 &&
      (child as Element).localName === name &&
      (child as Element).namespaceURI === ns,
  );
export function one(node: Element, name: string, ns = assertionNS) {
  const found = children(node, name, ns);
  return found.length === 1 ? found[0]! : invalid();
}
export function text(node: Element, limit: number) {
  if (
    Array.from(node.childNodes).some(
      (child) => ![3, 4].includes(child.nodeType),
    )
  )
    return invalid();
  const value = node.textContent ?? "";
  return value.length <= limit ? value : invalid();
}
export function timestamp(value: string | null) {
  if (
    !value ||
    !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    return invalid();
  return Date.parse(value);
}
function timely(node: Element) {
  const expiry = timestamp(node.getAttribute("NotOnOrAfter"));
  const before = node.getAttribute("NotBefore");
  return (
    expiry > Date.now() - 60000 &&
    (!before || timestamp(before) <= Date.now() + 60000)
  );
}
export function signatureAlgorithms(root: Element, count = 2) {
  const signatures = Array.from(root.getElementsByTagNameNS(ds, "Signature"));
  if (signatures.length !== count) invalid();
  for (const signature of signatures) {
    const info = one(signature, "SignedInfo", ds);
    const method = one(info, "SignatureMethod", ds).getAttribute("Algorithm");
    if (
      ![
        "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
        "http://www.w3.org/2001/04/xmldsig-more#rsa-sha512",
      ].includes(method ?? "")
    )
      invalid();
    const reference = one(info, "Reference", ds);
    const digestMethod = one(reference, "DigestMethod", ds).getAttribute(
      "Algorithm",
    );
    if (
      ![
        "http://www.w3.org/2001/04/xmlenc#sha256",
        "http://www.w3.org/2001/04/xmlenc#sha512",
      ].includes(digestMethod ?? "")
    )
      invalid();
  }
}
// These structural checks only reject input. Node-SAML must still authenticate both signatures.
export function checkSamlEnvelope(
  encoded: string,
  requestId: string,
  settings: SamlSettings,
) {
  if (
    !encoded ||
    encoded.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
  )
    invalid();
  const xml = new TextDecoder("utf-8", { fatal: true }).decode(
    Buffer.from(encoded, "base64"),
  );
  const root = parseSamlXml(xml);
  if (
    root.namespaceURI !== protocolNS ||
    root.localName !== "Response" ||
    root.getAttribute("Version") !== "2.0" ||
    root.getAttribute("Destination") !== settings.callbackUrl ||
    root.getAttribute("InResponseTo") !== requestId
  )
    invalid();
  if (text(one(root, "Issuer"), 1024) !== settings.idpIssuer) invalid();
  const status = one(root, "Status", protocolNS);
  if (
    one(status, "StatusCode", protocolNS).getAttribute("Value") !==
    "urn:oasis:names:tc:SAML:2.0:status:Success"
  )
    invalid();
  one(root, "Assertion");
  if (
    root.getElementsByTagNameNS(assertionNS, "Assertion").length !== 1 ||
    root.getElementsByTagNameNS(assertionNS, "EncryptedAssertion").length
  )
    invalid();
  signatureAlgorithms(root);
}
export function samlIdentity(
  profile: Profile,
  requestId: string,
  settings: SamlSettings,
) {
  // Read identity and all authorization attributes only from the verified assertion.
  const xml = profile.getAssertionXml?.();
  if (!xml) return invalid();
  const root = parseSamlXml(xml);
  if (
    root.localName !== "Assertion" ||
    root.namespaceURI !== assertionNS ||
    root.getAttribute("Version") !== "2.0" ||
    !root.getAttribute("ID")
  )
    invalid();
  if (text(one(root, "Issuer"), 1024) !== settings.idpIssuer) invalid();
  const issued = timestamp(root.getAttribute("IssueInstant"));
  if (issued > Date.now() + 60000 || issued <= Date.now() - 360000) invalid();
  const conditions = one(root, "Conditions");
  if (!timely(conditions)) invalid();
  const restrictions = children(conditions, "AudienceRestriction");
  if (
    !restrictions.length ||
    restrictions.some(
      (restriction) =>
        !children(restriction, "Audience").some(
          (audience) => text(audience, 1024) === settings.entityId,
        ),
    )
  )
    invalid();
  const subject = one(root, "Subject");
  const nameID = one(subject, "NameID");
  const subjectId = text(nameID, 256);
  if (!subjectId.trim() || nameID.getAttribute("Format") !== persistentNameID)
    invalid();
  if (
    !children(subject, "SubjectConfirmation").some((confirmation) => {
      if (
        confirmation.getAttribute("Method") !==
        "urn:oasis:names:tc:SAML:2.0:cm:bearer"
      )
        return false;
      const data = one(confirmation, "SubjectConfirmationData");
      return (
        data.getAttribute("Recipient") === settings.callbackUrl &&
        data.getAttribute("InResponseTo") === requestId &&
        timely(data)
      );
    })
  )
    invalid();
  for (const [name, expected] of [
    ["NameQualifier", settings.idpIssuer],
    ["SPNameQualifier", settings.entityId],
  ])
    if (nameID.hasAttribute(name!) && nameID.getAttribute(name!) !== expected)
      invalid();
  const authn = one(root, "AuthnStatement");
  const sessionIndex = authn.getAttribute("SessionIndex");
  if (sessionIndex && (sessionIndex.length > 1024 || !sessionIndex.trim()))
    invalid();
  if (timestamp(authn.getAttribute("AuthnInstant")) > Date.now() + 60000)
    invalid();
  let maxAge = 3600;
  const sessionExpiry = authn.getAttribute("SessionNotOnOrAfter");
  if (sessionExpiry)
    maxAge = Math.min(
      maxAge,
      Math.floor((timestamp(sessionExpiry) - Date.now()) / 1000),
    );
  if (maxAge <= 0) invalid();
  const attributes: Record<string, string[]> = Object.create(null);
  for (const statement of children(root, "AttributeStatement"))
    for (const attribute of children(statement, "Attribute")) {
      const name = attribute.getAttribute("Name");
      if (!name || !["groups", "name", "email"].includes(name)) continue;
      if (Object.hasOwn(attributes, name)) invalid();
      const values = children(attribute, "AttributeValue");
      if (values.length > (name === "groups" ? 500 : 1)) invalid();
      attributes[name] = values.map((value) =>
        text(value, name === "email" ? 254 : 160),
      );
    }
  const identity = identityFromClaims({
    sub: `saml:${digest(JSON.stringify([settings.idpIssuer, subjectId]))}`,
    name: attributes.name?.[0] || "Team member",
    email: attributes.email?.[0] ?? "",
    groups: attributes.groups ?? [],
  });
  return {
    identity: {
      ...identity,
      provider: "saml" as const,
      issuer: settings.idpIssuer,
      subject: subjectId,
    },
    maxAge,
    saml: {
      issuer: settings.idpIssuer,
      nameID: subjectId,
      nameIDFormat: persistentNameID,
      ...(nameID.hasAttribute("NameQualifier")
        ? { nameQualifier: nameID.getAttribute("NameQualifier")! }
        : {}),
      ...(nameID.hasAttribute("SPNameQualifier")
        ? { spNameQualifier: nameID.getAttribute("SPNameQualifier")! }
        : {}),
      ...(sessionIndex ? { sessionIndex } : {}),
      startedAt: Date.now(),
    },
  };
}
