import { digest } from "./local-auth";
import type { Store } from "./store";

// Kept only in server-side sessions; never sent in bootstrap or integration credentials.
export type SamlSession = {
  issuer: string;
  nameID: string;
  nameIDFormat: string;
  nameQualifier?: string;
  spNameQualifier?: string;
  sessionIndex?: string;
  startedAt: number;
};
export const samlRevocationKey = (
  issuer: string,
  nameID: string,
  index?: string,
) => `SAML_REVOKED#${digest(JSON.stringify([issuer, nameID, index ?? null]))}`;
export type SamlRevocation = { version: number; before: number; ttl: number };
export async function samlSessionRevoked(store: Store, session: SamlSession) {
  const keys = [samlRevocationKey(session.issuer, session.nameID)];
  if (session.sessionIndex)
    keys.push(
      samlRevocationKey(session.issuer, session.nameID, session.sessionIndex),
    );
  const records = await Promise.all(
    keys.map((key) => store.get<SamlRevocation>(key, "META")),
  );
  return records.some(
    (record) =>
      record &&
      record.ttl > Date.now() / 1000 &&
      session.startedAt <= record.before,
  );
}
