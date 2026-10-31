export type Role = "admin" | "manager" | "user";
export type AuthMode = "demo" | "local" | "okta" | "saml";
export type IdentityProvider = Exclude<AuthMode, "demo">;
import { translationComplete, type PluralCategory } from "./messages";
export type Locale = {
  code: string;
  name: string;
  pluralForms?: PluralCategory[];
  ordinalForms?: PluralCategory[];
};
export type Project = {
  id: string;
  name: string;
  description: string;
  sourceLanguage: string;
  languages: Locale[];
  color: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  importId?: string;
  importedBy?: string;
  dataRevision?: string;
  snapshotPolicy?: {
    enabled: boolean;
    intervalHours: number;
    retention: number;
  };
};
export type TranslationKey = {
  id?: string;
  name: string;
  description: string;
  namespace: string;
  tags: string[];
  translations: Record<string, string>;
  version: number;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
  searchText?: string;
  filledLanguages?: string[];
  importId?: string;
  sourceRevision?: number;
  sourceContext?: string;
  translationSources?: Record<string, string>;
  outdatedLanguages?: string[];
  populatedLanguages?: string[];
  plural?: boolean;
  resolvedTranslations?: Record<string, string>;
  referenceErrors?: Record<string, string>;
};
export type ProjectStats = {
  totalKeys: number;
  byLanguage: Record<string, number>;
  coverage: Record<string, number>;
  namespaces: Record<string, number>;
  version: number;
  advancedKeys?: number;
  outdatedByLanguage?: Record<string, number>;
  outdatedKeys?: number;
  messageVersion?: number;
};
export type KeyPage = {
  items: TranslationKey[];
  nextCursor?: string;
  stats: ProjectStats;
};
export type Identity = {
  sub: string;
  name: string;
  email: string;
  admin: boolean;
  projects: Record<string, Role>;
  tokenProject?: string;
  demo?: boolean;
  provider?: IdentityProvider;
  issuer?: string;
  subject?: string;
  authTime?: number;
  sessionExpiresAt?: number;
  principalId?: string;
  accessVersion?: number;
  sync?: { projectId: string; credentialId: string; prefixes: string[] };
  mcp?: {
    projectId: string;
    credentialId: string;
    languages: string[];
    allowOverwrite: boolean;
  };
};
export type McpTokenView = {
  id: string;
  name: string;
  prefix: string;
  languages: string[];
  allowOverwrite: boolean;
  createdByName: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt?: string;
};
export type Token = {
  hash: string;
  name: string;
  prefix: string;
  expiresAt: string;
  createdAt: string;
  createdBy: string;
  version: number;
};
export type ProjectSummary = Project & { role: Role };
export type Bootstrap = {
  identity: Identity;
  projects: ProjectSummary[];
  authMode: AuthMode;
};
export type LocalUserView = {
  id: string;
  name: string;
  email: string;
  workspaceRole: "admin" | "member";
  projects: Record<string, Role>;
  status: "invited" | "active" | "disabled";
  hasPassword: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export const LANGUAGES: Locale[] = [
  { code: "en", name: "English" },
  { code: "fr", name: "French" },
  { code: "nl", name: "Dutch" },
  { code: "de", name: "German" },
  { code: "es", name: "Spanish" },
  { code: "it", name: "Italian" },
  { code: "pt", name: "Portuguese" },
  { code: "pt-BR", name: "Portuguese (Brazil)" },
  { code: "ja", name: "Japanese" },
  { code: "ko", name: "Korean" },
  { code: "zh", name: "Chinese" },
  { code: "zh-TW", name: "Chinese (Traditional)" },
  { code: "ar", name: "Arabic" },
  { code: "he", name: "Hebrew" },
  { code: "pl", name: "Polish" },
  { code: "uk", name: "Ukrainian" },
  { code: "sv", name: "Swedish" },
  { code: "da", name: "Danish" },
  { code: "fi", name: "Finnish" },
  { code: "nb", name: "Norwegian" },
  { code: "cs", name: "Czech" },
  { code: "tr", name: "Turkish" },
  { code: "hi", name: "Hindi" },
  { code: "id", name: "Indonesian" },
];
export function progress(keys: TranslationKey[], language: string) {
  return keys.length
    ? Math.round(
        (keys.filter((k) =>
          translationComplete(k, { code: language, name: language }),
        ).length /
          keys.length) *
          100,
      )
    : 0;
}
export function isComplete(key: TranslationKey, project: Project) {
  return project.languages.every((l) => translationComplete(key, l));
}
