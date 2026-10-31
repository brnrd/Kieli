import {
  createPrivateKey,
  createPublicKey,
  X509Certificate,
} from "node:crypto";
import { config, required } from "./config";

export const persistentNameID =
  "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent";
export type SamlSettings = {
  entryPoint: string;
  idpIssuer: string;
  entityId: string;
  callbackUrl: string;
  idpCert: string[];
  privateKey: string;
  publicCert: string;
};
type Credentials = {
  SAML_IDP_CERT: string;
  SAML_SP_PRIVATE_KEY: string;
  SAML_SP_CERT: string;
};
let secretsCache:
  { arn: string; until: number; value: Promise<Credentials> } | undefined;
async function credentials(): Promise<Credentials> {
  const arn = process.env.SAML_SECRETS_ARN;
  if (!arn)
    return {
      SAML_IDP_CERT: required("SAML_IDP_CERT"),
      SAML_SP_PRIVATE_KEY: required("SAML_SP_PRIVATE_KEY"),
      SAML_SP_CERT: required("SAML_SP_CERT"),
    };
  if (
    !secretsCache ||
    secretsCache.arn !== arn ||
    secretsCache.until <= Date.now()
  ) {
    const value = (async () => {
      const { SecretsManagerClient, GetSecretValueCommand } =
        await import("@aws-sdk/client-secrets-manager");
      const result = await new SecretsManagerClient({}).send(
        new GetSecretValueCommand({ SecretId: arn }),
      );
      if (!result.SecretString)
        throw new Error("SAML secret must contain JSON text.");
      const parsed = JSON.parse(result.SecretString) as Record<string, unknown>;
      for (const name of [
        "SAML_IDP_CERT",
        "SAML_SP_PRIVATE_KEY",
        "SAML_SP_CERT",
      ])
        if (typeof parsed[name] !== "string" || !parsed[name])
          throw new Error(`Missing ${name} in SAML secret.`);
      return parsed as Credentials;
    })();
    secretsCache = { arn, until: Date.now() + 300000, value };
    value.catch(() => {
      if (secretsCache?.value === value) secretsCache = undefined;
    });
  }
  return secretsCache.value;
}
const pem = (value: string) => value.replace(/\\n/g, "\n").trim();
function certificate(value: string) {
  const cert = new X509Certificate(value);
  if (
    cert.publicKey.asymmetricKeyType !== "rsa" ||
    (cert.publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
  )
    throw new Error(
      "SAML signing certificates must use RSA with at least 2048 bits.",
    );
  return cert;
}
const current = (cert: X509Certificate) =>
  Date.parse(cert.validFrom) <= Date.now() &&
  Date.now() < Date.parse(cert.validTo);
export async function samlSettings(): Promise<SamlSettings> {
  if (config().authMode !== "saml")
    throw new Error("SAML sign-in is not enabled.");
  const entryPoint = new URL(required("SAML_ENTRY_POINT"));
  if (
    entryPoint.protocol !== "https:" ||
    entryPoint.username ||
    entryPoint.password ||
    entryPoint.hash
  )
    throw new Error(
      "SAML_ENTRY_POINT must be an HTTPS URL without credentials or a fragment.",
    );
  for (const name of [
    "SAMLRequest",
    "SAMLResponse",
    "RelayState",
    "Signature",
    "SigAlg",
  ])
    if (entryPoint.searchParams.has(name))
      throw new Error("SAML_ENTRY_POINT cannot contain protocol parameters.");
  const idpIssuer = required("SAML_IDP_ISSUER");
  const entityId =
    process.env.SAML_SP_ENTITY_ID ?? `${config().origin}/auth/saml/metadata`;
  if (idpIssuer.length > 1024 || entityId.length > 1024 || !entityId.trim())
    throw new Error("Invalid SAML entity identifier.");
  const secret = await credentials();
  const bundle = pem(secret.SAML_IDP_CERT);
  const certificates =
    bundle.match(
      /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
    ) ?? [];
  if (
    !certificates.length ||
    certificates.length > 3 ||
    bundle
      .replace(
        /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
        "",
      )
      .trim()
  )
    throw new Error(
      "SAML_IDP_CERT must be a PEM bundle of one to three trusted signing certificates.",
    );
  const idpCert = certificates.filter((value) => current(certificate(value)));
  if (!idpCert.length)
    throw new Error(
      "No current SAML identity-provider signing certificate is configured.",
    );
  const privateKey = pem(secret.SAML_SP_PRIVATE_KEY);
  const key = createPrivateKey(privateKey);
  const publicCert = pem(secret.SAML_SP_CERT);
  const cert = certificate(publicCert);
  if (
    !current(cert) ||
    !cert.publicKey
      .export({ type: "spki", format: "der" })
      .equals(createPublicKey(key).export({ type: "spki", format: "der" }))
  )
    throw new Error(
      "SAML_SP_CERT must be current and match SAML_SP_PRIVATE_KEY.",
    );
  return {
    entryPoint: entryPoint.href,
    idpIssuer,
    entityId,
    callbackUrl: `${config().origin}/auth/saml/acs`,
    idpCert,
    privateKey,
    publicCert,
  };
}
