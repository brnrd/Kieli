import type { Identity, Project, WorkspaceOverview } from "../shared";
import { enabledLanguages } from "../shared";
import { HttpError } from "./errors";
import { config } from "./config";
import { KieliService } from "./service";
import type { Store } from "./store";

export async function workspaceOverview(
  identity: Identity,
  store: Store,
): Promise<WorkspaceOverview> {
  if (!identity.admin || identity.mcp || identity.tokenProject || identity.sync)
    throw new HttpError(
      403,
      "Only workspace admins can view workspace statistics.",
    );
  const service = new KieliService(store),
    projects = await store.list<Project>("WORKSPACE", "PROJECT#");
  const rows: WorkspaceOverview["projects"] = [];
  // Bound concurrent database work, including cold reference/plural summaries.
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, projects.length) }, async () => {
      while (index < projects.length) {
        const project = projects[index++]!,
          stats = await service.summary(identity, project.id);
        const targets = enabledLanguages(project).filter(
          (locale) => locale.code !== project.sourceLanguage,
        );
        const slots = stats.totalKeys * targets.length;
        const current = targets.reduce(
          (sum, locale) => sum + (stats.byLanguage[locale.code] ?? 0),
          0,
        );
        const outdated = targets.reduce(
          (sum, locale) => sum + (stats.outdatedByLanguage?.[locale.code] ?? 0),
          0,
        );
        rows.push({
          id: project.id,
          name: project.name,
          keys: stats.totalKeys,
          languages: enabledLanguages(project).length,
          current,
          outdated,
          missing: Math.max(0, slots - current - outdated),
          targetSlots: slots,
        });
      }
    }),
  );
  const totals = rows.reduce(
    (sum, row) => ({
      keys: sum.keys + row.keys,
      current: sum.current + row.current,
      outdated: sum.outdated + row.outdated,
      missing: sum.missing + row.missing,
      targetSlots: sum.targetSlots + row.targetSlots,
    }),
    { keys: 0, current: 0, outdated: 0, missing: 0, targetSlots: 0 },
  );
  return {
    generatedAt: new Date().toISOString(),
    authMode: config().authMode,
    storage: config().driver,
    totals,
    projects: rows.sort((a, b) => a.name.localeCompare(b.name)),
  };
}
