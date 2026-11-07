import { createHash, randomUUID } from "node:crypto";
import type { Identity, TranslationKey } from "../shared";
import type { Change } from "./store";
export type EditOrigin =
  | "browser"
  | "mcp"
  | "import"
  | "restore"
  | "recovery"
  | "sync"
  | "rename"
  | "metadata"
  | "duplicate";
export type KeyState = Pick<
  TranslationKey,
  | "name"
  | "translations"
  | "description"
  | "namespace"
  | "tags"
  | "applePluralTypes"
  | "plural"
  | "sourceRevision"
  | "translationSources"
  | "version"
  | "createdAt"
  | "updatedAt"
  | "updatedBy"
  | "id"
>;
export type KeyEdit = {
  version: number;
  id: string;
  keyId: string;
  keyName: string;
  sourceLanguage?: string;
  at: string;
  actor: string;
  actorName: string;
  origin: EditOrigin;
  before?: KeyState;
  after?: KeyState;
};
export type DeletedKey = {
  version: number;
  id: string;
  key: KeyState;
  deletedAt: string;
  deletedBy: string;
  ttl: number;
  searchText: string;
};
export function legacyKeyId(project: string, name: string) {
  const hex = createHash("sha256")
    .update(JSON.stringify([project, name]))
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export function keyState(key: TranslationKey): KeyState {
  const {
    id,
    name,
    translations,
    description,
    namespace,
    tags,
    plural,
    applePluralTypes,
    sourceRevision,
    translationSources,
    version,
    createdAt,
    updatedAt,
    updatedBy,
  } = key;
  return {
    id,
    name,
    translations,
    description,
    namespace,
    tags,
    plural,
    applePluralTypes,
    sourceRevision,
    translationSources,
    version,
    createdAt,
    updatedAt,
    updatedBy,
  };
}
export function editChange(
  project: string,
  identity: Identity,
  origin: EditOrigin,
  before: TranslationKey | undefined,
  after: TranslationKey | undefined,
): Change {
  const key = (after ?? before)!,
    at = new Date().toISOString(),
    id = `${String(after?.version ?? key.version + 1).padStart(16, "0")}_${at}_${randomUUID()}`;
  const entry: KeyEdit = {
    version: 1,
    id,
    keyId: key.id ?? legacyKeyId(project, key.name),
    keyName: key.name,
    at,
    actor: identity.sub,
    actorName: identity.name,
    origin,
    ...(before ? { before: keyState(before) } : {}),
    ...(after ? { after: keyState(after) } : {}),
  };
  return {
    pk: `PROJECT#${project}`,
    sk: `KEY_HISTORY#${entry.keyId}#${id}`,
    value: entry,
  };
}
