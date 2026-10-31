import type { Project, ProjectStats, TranslationKey } from "../shared";
import { freshnessView } from "./freshness";
import { translationComplete, resolveProject } from "../messages";
export const dataPrefix = (project: Project) =>
  project.dataRevision ? `REV#${project.dataRevision}#` : "";
export function viewStats(
  raw: ProjectStats,
  keys: TranslationKey[],
  project: Project,
): ProjectStats {
  const byLanguage: Record<string, number> = {},
    coverage: Record<string, number> = {};
  const outdatedByLanguage: Record<string, number> = {};
  let outdatedKeys = 0;
  for (const key of keys) {
    if (key.outdatedLanguages?.length) outdatedKeys++;
    for (const code of key.outdatedLanguages ?? [])
      outdatedByLanguage[code] = (outdatedByLanguage[code] ?? 0) + 1;
    const filled = project.languages
      .filter((locale) => translationComplete(key, locale))
      .map((locale) => locale.code)
      .sort();
    for (const code of filled) byLanguage[code] = (byLanguage[code] ?? 0) + 1;
    const signature = filled.join(",") || "-";
    coverage[signature] = (coverage[signature] ?? 0) + 1;
  }
  return { ...raw, byLanguage, coverage, outdatedByLanguage, outdatedKeys };
}
const scopes = new WeakMap<
  object,
  Map<string, { keys: TranslationKey[]; bytes: number; time: number }>
>();
export function cachedView(
  scope: object,
  id: string,
  project: Project,
  stats: ProjectStats,
  raw?: TranslationKey[],
) {
  let cache = scopes.get(scope);
  if (!cache) {
    cache = new Map();
    scopes.set(scope, cache);
  }
  const key = `${id}:${project.dataRevision ?? "legacy"}:${project.version}:${stats.version}`;
  if (!raw) {
    const entry = cache.get(key);
    return entry && Date.now() - entry.time < 30000 ? entry.keys : undefined;
  }
  const keys = freshnessView(resolveProject(raw, project), project);
  const bytes = Buffer.byteLength(JSON.stringify(keys));
  for (const [old, entry] of cache)
    if (Date.now() - entry.time > 30000 || old.startsWith(`${id}:`))
      cache.delete(old);
  let total = [...cache.values()].reduce((sum, entry) => sum + entry.bytes, 0);
  while (cache.size && total + bytes > 20 * 1024 * 1024) {
    const first = cache.keys().next().value!;
    total -= cache.get(first)!.bytes;
    cache.delete(first);
  }
  if (bytes <= 20 * 1024 * 1024)
    cache.set(key, { keys, bytes, time: Date.now() });
  return keys;
}
