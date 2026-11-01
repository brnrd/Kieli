export type MemorySuggestion = {
  id: string;
  text: string;
  keyName: string;
  keyVersion: number;
  savedAt: string;
  savedBy: string;
  recordedAt: string;
  origin: string;
  side: "before" | "after";
};
export type MemoryIndexStatus = { done: boolean; scanned: number };
export type MemoryPage = {
  items: MemorySuggestion[];
  nextCursor?: string;
  index: MemoryIndexStatus;
};
