export type MetadataValues = { namespace: string; tags: string[] };
export type MetadataOperation = {
  addTags: string[];
  removeTags: string[];
  namespace?: string;
};
export type MetadataEntry = {
  name: string;
  keyId: string;
  version: number;
  before: MetadataValues;
  after: MetadataValues;
  changed: boolean;
};
export type MetadataPreview = {
  id: string;
  entries: MetadataEntry[];
  total: number;
  changed: number;
  unchanged: number;
  processed: number;
  updated: number;
  skipped: number;
  done: boolean;
  expiresAt: string;
};
