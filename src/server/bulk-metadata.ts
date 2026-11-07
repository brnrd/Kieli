import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { MetadataEntry, MetadataPreview } from "../bulk-metadata";
import type { Identity, ProjectStats, TranslationKey } from "../shared";
import { keyNameSchema, keySchema } from "../validation";
import { authorize, HttpError } from "./auth";
import { config } from "./config";
import { dataPrefix } from "./project-data";
import { assertProjectEditable } from "./project-lifecycle";
import { count, indexed, type KieliService } from "./service";
import { editChange, legacyKeyId, type KeyEdit } from "./key-history";
import { memoryChanges } from "./translation-memory";
import { mcpAudit } from "./mcp-credentials";
import { Conflict, type Change, type Store } from "./store";

const tags = keySchema.shape.tags.refine(
  (values) => new Set(values).size === values.length,
  "Tags must be unique.",
);
const operation = z
  .object({
    addTags: tags.default([]),
    removeTags: tags.default([]),
    namespace: keySchema.shape.namespace.unwrap().optional(),
  })
  .strict()
  .refine(
    (data) =>
      data.namespace !== undefined ||
      data.addTags.length + data.removeTags.length > 0,
    "Choose a namespace or tags to change.",
  )
  .refine(
    (data) => !data.addTags.some((tag) => data.removeTags.includes(tag)),
    "A tag cannot be both added and removed.",
  );
const previewSchema = z
  .object({
    keys: z
      .array(
        z
          .object({ name: keyNameSchema, version: z.number().int().positive() })
          .strict(),
      )
      .min(1)
      .max(100),
    operation,
  })
  .strict();
type Plan = {
  version: number;
  id: string;
  actor: string;
  authMode: string;
  projectVersion: number;
  ttl: number;
  entries: MetadataEntry[];
  processed: number;
  updated: number;
  skipped: number;
};
function checkSize(
  key: Pick<
    TranslationKey,
    | "name"
    | "description"
    | "namespace"
    | "tags"
    | "translations"
    | "plural"
    | "applePluralTypes"
  >,
) {
  const {
    name,
    description,
    namespace,
    tags,
    translations,
    plural,
    applePluralTypes,
  } = key;
  if (
    Buffer.byteLength(
      JSON.stringify({
        name,
        description,
        namespace,
        tags,
        translations,
        plural,
        applePluralTypes,
      }),
    ) > 120000
  )
    throw new HttpError(
      413,
      `Key ${name} would exceed 120 KB. Shorten its metadata or copy.`,
    );
}
const actor = (identity: Identity) => identity.principalId ?? identity.sub;
const planKey = (id: string) => `METADATA_PLAN#${id}`;
function view(plan: Plan): MetadataPreview {
  const changed = plan.entries.filter((entry) => entry.changed).length;
  return {
    id: plan.id,
    entries: plan.entries,
    total: plan.entries.length,
    changed,
    unchanged: plan.entries.length - changed,
    processed: plan.processed,
    updated: plan.updated,
    skipped: plan.skipped,
    done: plan.processed === plan.entries.length,
    expiresAt: new Date(plan.ttl * 1000).toISOString(),
  };
}
// Metadata uses the same key, stats, history and memory records as individual edits.
// Copy/freshness are carried through verbatim; no reference resolution or translation acceptance is needed.
export class BulkMetadata {
  constructor(
    private store: Store,
    private service: KieliService,
  ) {}
  private authorize(identity: Identity, id: string) {
    if (identity.mcp || identity.sync || identity.tokenProject)
      throw new HttpError(403, "Sign in to change key metadata.");
    authorize(identity, id, "manager");
  }
  private async plan(identity: Identity, id: string, planId: string) {
    this.authorize(identity, id);
    z.uuid().parse(planId);
    const plan = await this.store.get<Plan>(`PROJECT#${id}`, planKey(planId));
    if (
      !plan ||
      plan.actor !== actor(identity) ||
      plan.authMode !== config().authMode ||
      plan.ttl <= Date.now() / 1000
    )
      throw new HttpError(
        404,
        "Metadata preview expired or belongs to another identity. Preview again.",
      );
    return plan;
  }
  async preview(identity: Identity, id: string, input: unknown) {
    this.authorize(identity, id);
    const data = previewSchema.parse(input);
    if (new Set(data.keys.map((key) => key.name)).size !== data.keys.length)
      throw new HttpError(400, "Select each key only once.");
    const project = await this.service.project(identity, id);
    assertProjectEditable(project);
    const entries: MetadataEntry[] = [];
    for (let offset = 0; offset < data.keys.length; offset += 8) {
      entries.push(
        ...(await Promise.all(
          data.keys.slice(offset, offset + 8).map(async (selected) => {
            const key = await this.store.get<TranslationKey>(
              `PROJECT#${id}`,
              `${dataPrefix(project)}KEY#${selected.name}`,
            );
            if (!key || key.version !== selected.version)
              throw new HttpError(
                409,
                `Key ${selected.name} changed or is no longer available. Refresh the selection and preview again.`,
              );
            const before = { namespace: key.namespace, tags: key.tags };
            const nextTags = [
              ...new Set([
                ...before.tags.filter(
                  (tag) => !data.operation.removeTags.includes(tag),
                ),
                ...data.operation.addTags,
              ]),
            ];
            if (nextTags.length > 12)
              throw new HttpError(
                400,
                `Key ${key.name} would have ${nextTags.length} tags. Remove tags to stay within the 12-tag limit.`,
              );
            const after = {
              namespace: data.operation.namespace ?? before.namespace,
              tags: tags.parse(nextTags),
            };
            checkSize({ ...key, ...after });
            return {
              name: key.name,
              keyId: key.id ?? legacyKeyId(id, key.name),
              version: key.version,
              before,
              after,
              changed:
                before.namespace !== after.namespace ||
                JSON.stringify(before.tags) !== JSON.stringify(after.tags),
            };
          }),
        )),
      );
    }
    const plan: Plan = {
      version: 1,
      id: randomUUID(),
      actor: actor(identity),
      authMode: config().authMode,
      projectVersion: project.version,
      ttl: Math.floor(Date.now() / 1000) + 3600,
      entries,
      processed: 0,
      updated: 0,
      skipped: 0,
    };
    if (Buffer.byteLength(JSON.stringify(plan)) > 250000)
      throw new HttpError(
        413,
        "This metadata preview is too large. Select fewer keys.",
      );
    await this.store.transact([
      {
        pk: "WORKSPACE",
        sk: `PROJECT#${id}`,
        check: true,
        expectedVersion: project.version,
      },
      { pk: `PROJECT#${id}`, sk: planKey(plan.id), value: plan },
    ]);
    return view(plan);
  }
  async status(identity: Identity, id: string, planId: string) {
    await this.service.project(identity, id);
    return view(await this.plan(identity, id, planId));
  }
  async apply(identity: Identity, id: string, planId: string, input: unknown) {
    const { offset } = z
      .object({ offset: z.number().int().min(0).max(100) })
      .strict()
      .parse(input);
    for (let attempt = 0; attempt < 8; attempt++) {
      const plan = await this.plan(identity, id, planId);
      const project = await this.service.project(identity, id);
      if (offset < plan.processed || plan.processed === plan.entries.length)
        return view(plan);
      if (offset !== plan.processed)
        throw new HttpError(409, "Read metadata progress before continuing.");
      assertProjectEditable(project);
      if (project.version !== plan.projectVersion)
        throw new HttpError(
          409,
          "Project settings changed. Preview the remaining keys again.",
        );
      const pk = `PROJECT#${id}`,
        prefix = dataPrefix(project);
      let stats = await this.store.get<ProjectStats>(pk, `${prefix}STATS`);
      if (stats?.messageVersion !== 3) {
        await this.service.summary(identity, id);
        stats = await this.store.get<ProjectStats>(pk, `${prefix}STATS`);
      }
      if (!stats) throw new Conflict();
      const nextStats = structuredClone(stats);
      const changes: Change[] = [];
      let processed = 0,
        updated = 0,
        skipped = 0;
      try {
        for (const entry of plan.entries.slice(offset, offset + 10)) {
          const old = await this.store.get<TranslationKey>(
            pk,
            `${prefix}KEY#${entry.name}`,
          );
          if (
            !old ||
            old.version !== entry.version ||
            (old.id ?? legacyKeyId(id, old.name)) !== entry.keyId
          )
            throw new HttpError(
              409,
              `Key ${entry.name} changed or is no longer available. Preview the remaining keys again.`,
            );
          const writes: Change[] = [];
          if (entry.changed) {
            const next = indexed({
              ...old,
              ...entry.after,
              id: entry.keyId,
              version: old.version + 1,
              updatedAt: new Date().toISOString(),
              updatedBy: identity.name,
            });
            checkSize(next);
            const history = editChange(id, identity, "metadata", old, next);
            const event = {
              ...(history.value as KeyEdit),
              sourceLanguage: project.sourceLanguage,
            };
            writes.push(
              {
                pk,
                sk: `${prefix}KEY#${entry.name}`,
                value: next,
                expectedVersion: old.version,
              },
              { ...history, value: event },
              ...memoryChanges(project, event),
            );
          } else
            writes.push({
              pk,
              sk: `${prefix}KEY#${entry.name}`,
              check: true,
              expectedVersion: old.version,
            });
          // Leave room for the receipt, project/stat fences and audit record.
          if (
            processed &&
            Buffer.byteLength(JSON.stringify([...changes, ...writes])) >
              2.5 * 1024 * 1024
          )
            break;
          changes.push(...writes);
          if (entry.changed) {
            const next = writes[0]!.value as TranslationKey;
            count(nextStats, old, -1);
            count(nextStats, next, 1);
            updated++;
          } else skipped++;
          processed++;
        }
        const nextPlan = {
          ...plan,
          version: plan.version + 1,
          processed: offset + processed,
          updated: plan.updated + updated,
          skipped: plan.skipped + skipped,
        };
        const fixed: Change[] = [
          {
            pk: "WORKSPACE",
            sk: `PROJECT#${id}`,
            check: true,
            expectedVersion: project.version,
          },
          {
            pk,
            sk: planKey(planId),
            expectedVersion: plan.version,
            value: nextPlan,
          },
          mcpAudit("keys.metadata_updated", actor(identity), id, {
            plan: planId,
            offset,
            updated,
            unchanged: skipped,
            keys: plan.entries
              .slice(offset, offset + processed)
              .map((entry) => entry.name),
          }),
        ];
        if (updated)
          fixed.push({
            pk,
            sk: `${prefix}STATS`,
            expectedVersion: stats.version,
            value: { ...nextStats, version: stats.version + 1 },
          });
        await this.store.transact([...fixed, ...changes]);
        return view(nextPlan);
      } catch (error) {
        const latest = await this.plan(identity, id, planId);
        if (latest.processed > offset) return view(latest);
        if (!(error instanceof Conflict) || attempt === 7) throw error;
        await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
      }
    }
    throw new Conflict();
  }
}
