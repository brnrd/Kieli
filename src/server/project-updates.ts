import { randomUUID } from "node:crypto";
import { assertProjectEditable } from "./project-lifecycle";
import { z } from "zod";
import { keySchema } from "../validation";
import type {
  Identity,
  Project,
  TranslationKey,
  ProjectStats,
} from "../shared";
import {
  looksPlural,
  resolveProject,
  references,
  advancedKey,
} from "../messages";
import { authorize } from "./auth";
import { HttpError } from "./errors";
import { Conflict, type Store, type Change } from "./store";
import type { KeyloService } from "./service";
import { freshnessView } from "./freshness";
import { dataPrefix } from "./project-data";
import { keyState, type KeyState, type EditOrigin } from "./key-history";
import { validateKeyQuality } from "./translation-quality";
import { config } from "./config";
export type KeyChange = {
  old?: TranslationKey;
  next?: TranslationKey;
  expectedVersion?: number;
  translatedLocales?: string[];
  expectedSourceContext?: string;
};
export type UpdateEntry = {
  name: string;
  action: "create" | "update" | "unchanged";
  before?: KeyState;
  after: z.infer<typeof keySchema>;
  translations: Record<string, string>;
  sourceContext?: string;
  preserved: string[];
};
type Plan = {
  version: number;
  id: string;
  actor: string;
  authMode: string;
  origin: EditOrigin;
  policy: "merge" | "source" | "overwrite";
  projectVersion: number;
  count: number;
  ttl: number;
  status: "ready" | "applied";
  result?: { created: number; updated: number; unchanged: number };
};
const actor = (identity: Identity) => identity.principalId ?? identity.sub;
const prefix = (plan: string) => `UPDATE_ITEM#${plan}#`;
const inputSchema = z
  .object({
    policy: z.enum(["merge", "source", "overwrite"]).default("merge"),
    keys: z.array(keySchema).min(1).max(20),
  })
  .strict();
const summary = (entries: UpdateEntry[]) => ({
  created: entries.filter((entry) => entry.action === "create").length,
  updated: entries.filter((entry) => entry.action === "update").length,
  unchanged: entries.filter((entry) => entry.action === "unchanged").length,
});
export class ProjectUpdates {
  constructor(
    readonly store: Store,
    readonly service: KeyloService,
    readonly commit: (
      changes: KeyChange[],
      additional: Change[],
      project: Project,
      origin: EditOrigin,
    ) => Promise<void>,
  ) {}
  async preview(
    identity: Identity,
    id: string,
    input: unknown,
    origin: EditOrigin = "import",
  ) {
    authorize(identity, id, "manager");
    if (identity.mcp || identity.tokenProject)
      throw new HttpError(403, "Sign in to update this project.");
    const data = inputSchema.parse(input),
      project = await this.service.project(identity, id);
    assertProjectEditable(project);
    if (new Set(data.keys.map((key) => key.name)).size !== data.keys.length)
      throw new HttpError(400, "Duplicate keys in this update.");
    if (
      identity.sync &&
      (identity.sync.projectId !== id ||
        data.policy !== "source" ||
        data.keys.some(
          (key) =>
            (identity.sync!.prefixes.length &&
              !identity.sync!.prefixes.some((prefix) =>
                key.name.startsWith(prefix),
              )) ||
            key.applePluralTypes !== undefined ||
            Object.keys(key.translations).some(
              (code) => code !== project.sourceLanguage,
            ),
        ))
    )
      throw new HttpError(
        403,
        "Source-sync credentials can only push source text within their key prefixes.",
      );
    const entries: UpdateEntry[] = [];
    for (const input of data.keys) {
      for (const code of Object.keys(input.translations))
        if (!project.languages.some((locale) => locale.code === code))
          throw new HttpError(
            400,
            `Language ${code} is not enabled. Add it in project settings before importing.`,
          );
      const raw = await this.store.get<TranslationKey>(
        `PROJECT#${id}`,
        `${dataPrefix(project)}KEY#${input.name}`,
      );
      const before = raw
        ? advancedKey(raw)
          ? await this.service.key(identity, id, input.name)
          : freshnessView([raw], project)[0]
        : undefined;
      const translations: Record<string, string> = {},
        preserved: string[] = [];
      for (const [code, text] of Object.entries(input.translations)) {
        if (
          !text.trim() ||
          (data.policy === "source" && code !== project.sourceLanguage)
        )
          continue;
        const existing = before?.translations[code];
        if (
          code === project.sourceLanguage ||
          !existing?.trim() ||
          data.policy === "overwrite"
        ) {
          if (
            text !== existing ||
            (data.policy === "overwrite" &&
              before?.outdatedLanguages?.includes(code))
          )
            translations[code] = text;
        } else if (text !== existing) preserved.push(code);
      }
      if (!before && !translations[project.sourceLanguage]?.trim())
        throw new HttpError(
          400,
          `New key ${input.name} needs source copy (${project.sourceLanguage}). Include the source file.`,
        );
      const applePluralTypes = { ...before?.applePluralTypes };
      for (const [code, type] of Object.entries(input.applePluralTypes ?? {})) {
        if (
          !project.languages.some((locale) => locale.code === code) ||
          !Object.hasOwn(input.translations, code)
        )
          throw new HttpError(
            400,
            "Apple plural metadata must accompany a configured translation language.",
          );
        if (
          code === project.sourceLanguage ||
          !before?.translations[code]?.trim() ||
          data.policy === "overwrite"
        )
          applePluralTypes[code] = type;
      }
      const after = keySchema.parse(
        before
          ? {
              name: before.name,
              description: before.description,
              namespace: before.namespace,
              tags: before.tags,
              plural: input.plural ?? before.plural,
              ...(Object.keys(applePluralTypes).length
                ? { applePluralTypes }
                : {}),
              translations: { ...before.translations, ...translations },
            }
          : {
              ...input,
              plural:
                input.plural ?? Object.values(translations).some(looksPlural),
              translations,
            },
      );
      const changed =
        Object.keys(translations).length > 0 ||
        !!after.plural !== !!before?.plural ||
        JSON.stringify(after.applePluralTypes ?? {}) !==
          JSON.stringify(before?.applePluralTypes ?? {});
      entries.push({
        name: input.name,
        action: !before ? "create" : changed ? "update" : "unchanged",
        ...(before ? { before: keyState(before) } : {}),
        after,
        translations,
        sourceContext: before?.sourceContext,
        preserved,
      });
    }
    // Validate linked messages against this batch and the existing project before presenting an applicable plan.
    const stats = await this.store.get<ProjectStats>(
      `PROJECT#${id}`,
      `${dataPrefix(project)}STATS`,
    );
    const current =
        stats?.advancedKeys ||
        entries.some((entry) => advancedKey(entry.after as TranslationKey))
          ? await this.service.keys(identity, id)
          : [],
      candidates = new Map(current.map((key) => [key.name, key]));
    for (const entry of entries)
      candidates.set(entry.name, {
        ...entry.after,
        version: entry.before?.version ?? 1,
        createdAt: "",
        updatedAt: "",
        updatedBy: "",
      });
    const unresolvedReferences = [
      ...new Set(
        entries.flatMap((entry) =>
          Object.values(entry.after.translations).flatMap(references),
        ),
      ),
    ].filter((name) => !candidates.has(name));
    for (const name of unresolvedReferences)
      candidates.set(name, {
        name,
        translations: {},
        namespace: "general",
        description: "",
        tags: [],
        version: 1,
        createdAt: "",
        updatedAt: "",
        updatedBy: "",
      });
    try {
      resolveProject(
        [...candidates.values()],
        project,
        true,
        new Set(entries.map((entry) => entry.name)),
      );
    } catch (error) {
      throw new HttpError(422, (error as Error).message);
    }
    const quality = new Map(
      resolveProject([...candidates.values()], project).map((key) => [
        key.name,
        key,
      ]),
    );
    for (const entry of entries)
      validateKeyQuality(
        quality.get(entry.name)!,
        project,
        Object.keys(entry.translations),
        entry.before,
      );
    // Leave room for indexed keys, immutable history, counters and lifecycle markers under DynamoDB's transaction ceiling.
    if (Buffer.byteLength(JSON.stringify(entries)) * 3 > 3 * 1024 * 1024)
      throw new HttpError(
        413,
        "This update batch is too large. Preview fewer keys at a time.",
      );
    const plan: Plan = {
      version: 1,
      id: randomUUID(),
      actor: actor(identity),
      authMode: config().authMode,
      origin,
      policy: data.policy,
      projectVersion: project.version,
      count: entries.length,
      ttl: Math.floor(Date.now() / 1000) + 86400,
      status: "ready",
    };
    await this.store.transact([
      { pk: `PROJECT#${id}`, sk: `UPDATE_PLAN#${plan.id}`, value: plan },
      {
        pk: "WORKSPACE",
        sk: `PROJECT#${id}`,
        check: true,
        expectedVersion: project.version,
      },
      ...entries.map((entry, index) => ({
        pk: `PROJECT#${id}`,
        sk: `${prefix(plan.id)}${String(index).padStart(5, "0")}`,
        value: { version: 1, entry, ttl: plan.ttl },
      })),
    ]);
    return {
      id: plan.id,
      policy: plan.policy,
      ...summary(entries),
      entries: identity.sync
        ? entries.map((entry) => ({
            ...entry,
            preserved: [],
            before: entry.before
              ? {
                  ...entry.before,
                  applePluralTypes: undefined,
                  translations: {
                    [project.sourceLanguage]:
                      entry.before.translations[project.sourceLanguage] ?? "",
                  },
                }
              : undefined,
            after: {
              ...entry.after,
              applePluralTypes: undefined,
              translations: {
                [project.sourceLanguage]:
                  entry.after.translations[project.sourceLanguage] ?? "",
              },
            },
          }))
        : entries,
      expiresAt: new Date(plan.ttl * 1000).toISOString(),
      unresolvedReferences,
    };
  }
  async apply(identity: Identity, id: string, planId: string) {
    authorize(identity, id, "manager");
    if (identity.mcp || identity.tokenProject)
      throw new HttpError(403, "Sign in to update this project.");
    assertProjectEditable(await this.service.project(identity, id));
    z.uuid().parse(planId);
    const pk = `PROJECT#${id}`,
      plan = await this.store.get<Plan>(pk, `UPDATE_PLAN#${planId}`);
    if (
      !plan ||
      plan.actor !== actor(identity) ||
      plan.authMode !== config().authMode ||
      plan.ttl <= Date.now() / 1000
    )
      throw new HttpError(
        404,
        "Update preview expired or belongs to another identity. Preview again.",
      );
    if (plan.status === "applied") return { ...plan.result, replayed: true };
    try {
      const project = await this.service.project(identity, id);
      if (project.version !== plan.projectVersion) throw new Conflict();
      const rows = await this.store.list<{ entry: UpdateEntry }>(
        pk,
        prefix(planId),
      );
      if (rows.length !== plan.count)
        throw new HttpError(
          409,
          "Update preview is incomplete. Preview again.",
        );
      const entries = rows.map((row) => row.entry),
        changes: KeyChange[] = [],
        checks: Change[] = [];
      for (const entry of entries) {
        const current = await this.store.get<TranslationKey>(
          pk,
          `${dataPrefix(project)}KEY#${entry.name}`,
        );
        if (
          current?.version !== entry.before?.version ||
          current?.id !== entry.before?.id
        )
          throw new Conflict();
        if (entry.action === "unchanged") {
          if (current)
            checks.push({
              pk,
              sk: `${dataPrefix(project)}KEY#${entry.name}`,
              check: true,
              expectedVersion: current.version,
            });
          continue;
        }
        const at = new Date().toISOString();
        changes.push({
          old: current,
          next: {
            ...current,
            ...entry.after,
            version: (current?.version ?? 0) + 1,
            createdAt: current?.createdAt ?? at,
            updatedAt: at,
            updatedBy: identity.name,
          },
          expectedVersion: current?.version,
          translatedLocales: Object.keys(entry.translations),
          expectedSourceContext: entry.sourceContext,
        });
      }
      if (
        identity.sync &&
        (plan.policy !== "source" ||
          entries.some(
            (entry) =>
              (identity.sync!.prefixes.length &&
                !identity.sync!.prefixes.some((prefix) =>
                  entry.name.startsWith(prefix),
                )) ||
              Object.keys(entry.translations).some(
                (code) => code !== project.sourceLanguage,
              ),
          ))
      )
        throw new HttpError(403, "Update is outside source-sync scope.");
      const result = summary(entries);
      await this.commit(
        changes,
        [
          ...checks,
          {
            pk,
            sk: `UPDATE_PLAN#${planId}`,
            value: {
              ...plan,
              version: plan.version + 1,
              status: "applied",
              result,
            },
            expectedVersion: plan.version,
          },
        ],
        project,
        plan.origin,
      );
      return { ...result, replayed: false };
    } catch (error) {
      if (error instanceof Conflict) {
        const committed = await this.store.get<Plan>(
          pk,
          `UPDATE_PLAN#${planId}`,
        );
        if (committed?.status === "applied")
          return { ...committed.result, replayed: true };
      }
      throw error;
    }
  }
}
