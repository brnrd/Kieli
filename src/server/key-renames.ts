import { z } from "zod";
import { assertProjectEditable } from "./project-lifecycle";
import type { Identity, ProjectStats, TranslationKey } from "../shared";
import { keyNameSchema, keySchema } from "../validation";
import { referencePattern, references as keyReferences } from "../messages";
import { authorize, HttpError } from "./auth";
import { Conflict, type Change, type Store } from "./store";
import { dataPrefix } from "./project-data";
import { sourceContexts, freshnessView } from "./freshness";
import { editChange, legacyKeyId, type KeyEdit } from "./key-history";
import { memoryChanges } from "./translation-memory";
import { mcpAudit } from "./mcp-credentials";
import { indexed, type KeyloService } from "./service";

const inputSchema = z
  .object({
    name: keyNameSchema,
    version: z.number().int().positive(),
    projectVersion: z.number().int().positive().optional(),
    statsVersion: z.number().int().positive().optional(),
  })
  .strict();

// The stats CAS is the project-wide write fence, including newly added references.
// Do not retry a preview against a newer graph: the user must see its impact first.
export class KeyRenames {
  constructor(
    private store: Store,
    private service: KeyloService,
  ) {}
  async run(
    identity: Identity,
    id: string,
    name: string,
    input: unknown,
    apply = false,
  ) {
    if (identity.mcp || identity.sync || identity.tokenProject)
      throw new HttpError(403, "Sign in to rename keys.");
    authorize(identity, id, "manager");
    keyNameSchema.parse(name);
    const data = inputSchema.parse(input);
    if (data.name === name)
      throw new HttpError(400, "Choose a different key name.");
    const project = await this.service.project(identity, id);
    assertProjectEditable(project);
    await this.service.summary(identity, id); // Initialize legacy statistics if necessary.
    const pk = `PROJECT#${id}`,
      prefix = dataPrefix(project);
    const stats = (await this.store.get<ProjectStats>(pk, `${prefix}STATS`))!;
    if (
      apply &&
      (data.projectVersion !== project.version ||
        data.statsVersion !== stats.version)
    )
      throw new Conflict();
    const keys = await this.store.list<TranslationKey>(pk, `${prefix}KEY#`);
    const original = keys.find((key) => key.name === name);
    if (!original)
      throw new HttpError(
        404,
        "Key not found. It may have been renamed; reload the project.",
      );
    if (original.version !== data.version) throw new Conflict();
    if (keys.some((key) => key.name === data.name))
      throw new HttpError(409, "A key with this name already exists.");
    if (
      keys.some((key) =>
        Object.values(key.translations).some((text) =>
          keyReferences(text).includes(data.name),
        ),
      )
    )
      throw new HttpError(
        409,
        "The new name is already used by an unresolved reference. Fix that reference before renaming.",
      );
    const generations = await Promise.all(
      [name, data.name].map(async (key) => ({
        name: key,
        record: await this.store.get<{ version: number; lastVersion: number }>(
          pk,
          `KEY_GENERATION#${key}`,
        ),
      })),
    );
    const before = sourceContexts(keys, project);
    const references: { name: string; languages: string[] }[] = [];
    const candidates = keys.map((key) => {
      const languages: string[] = [];
      const translations = Object.fromEntries(
        Object.entries(key.translations).map(([locale, text]) => {
          const rewritten = text.replace(
            referencePattern,
            (match, target: string) =>
              target === name ? `[%key:${data.name}%]` : match,
          );
          if (rewritten !== text) languages.push(locale);
          return [locale, rewritten];
        }),
      );
      if (languages.length) references.push({ name: key.name, languages });
      return {
        ...key,
        name: key.name === name ? data.name : key.name,
        translations,
      };
    });
    const after = sourceContexts(candidates, project);
    const changes: { old: TranslationKey; next: TranslationKey }[] = [];
    const at = new Date().toISOString();
    for (let i = 0; i < keys.length; i++) {
      const old = keys[i]!,
        next = candidates[i]!;
      const oldContext = before.get(old.name)!,
        newContext = after.get(next.name)!;
      const contextChanged = oldContext.token !== newContext.token;
      if (
        old.name === next.name &&
        !contextChanged &&
        JSON.stringify(old.translations) === JSON.stringify(next.translations)
      )
        continue;
      // Reference spelling changed, but resolved source copy did not. Rebase only
      // current stamps; never certify previously outdated target copy.
      const translationSources = { ...old.translationSources };
      if (contextChanged)
        for (const locale of project.languages) {
          const stamp = old.translationSources?.[locale.code];
          if (
            locale.code === project.sourceLanguage ||
            stamp === oldContext.token ||
            (!stamp && oldContext.baseline)
          )
            translationSources[locale.code] = newContext.token;
        }
      next.id = old.id ?? legacyKeyId(id, old.name);
      next.version = Math.max(
        old.version + 1,
        old.name !== next.name
          ? (generations[1]!.record?.lastVersion ?? 0) + 1
          : 0,
      );
      next.translationSources = translationSources;
      next.updatedAt = at;
      next.updatedBy = identity.name;
      keySchema.parse({
        name: next.name,
        description: next.description,
        namespace: next.namespace,
        tags: next.tags,
        translations: next.translations,
        plural: next.plural,
        applePluralTypes: next.applePluralTypes,
      });
      changes.push({ old, next });
    }
    const decorated = new Map(
      freshnessView(candidates, project).map((key) => [key.name, indexed(key)]),
    );
    const transaction: Change[] = [
      {
        pk: "WORKSPACE",
        sk: `PROJECT#${id}`,
        check: true,
        expectedVersion: project.version,
      },
      {
        pk,
        sk: `${prefix}STATS`,
        expectedVersion: stats.version,
        value: { ...stats, version: stats.version + 1 },
      },
      ...generations.map(({ name: key, record }) => ({
        pk,
        sk: `KEY_GENERATION#${key}`,
        expectedVersion: record?.version,
        value: {
          version: (record?.version ?? 0) + 1,
          lastVersion:
            key === name ? original.version : decorated.get(data.name)!.version,
        },
      })),
      ...changes.flatMap(({ old, next }) => {
        const saved = decorated.get(next.name)!;
        const entry = editChange(id, identity, "rename", old, saved);
        const event = {
          ...(entry.value as KeyEdit),
          sourceLanguage: project.sourceLanguage,
        };
        return [
          { ...entry, value: event },
          ...memoryChanges(project, event),
          ...(old.name !== next.name
            ? [
                {
                  pk,
                  sk: `${prefix}KEY#${old.name}`,
                  expectedVersion: old.version,
                },
              ]
            : []),
          {
            pk,
            sk: `${prefix}KEY#${next.name}`,
            expectedVersion: old.name === next.name ? old.version : undefined,
            value: saved,
          },
        ];
      }),
      mcpAudit("key.renamed", identity.principalId ?? identity.sub, id, {
        from: name,
        to: data.name,
        affectedKeys: changes.length,
      }),
    ];
    if (
      transaction.length > 100 ||
      Buffer.byteLength(JSON.stringify(transaction)) > 3.5 * 1024 * 1024
    )
      throw new HttpError(
        413,
        "This rename affects too much data for one atomic transaction. No keys were changed.",
      );
    // Detect an inconsistent preview too, even though commit guards also protect apply.
    if (
      (await this.service.project(identity, id)).version !== project.version ||
      (await this.store.get<ProjectStats>(pk, `${prefix}STATS`))?.version !==
        stats.version
    )
      throw new Conflict();
    if (!apply)
      return {
        name: data.name,
        version: original.version,
        projectVersion: project.version,
        statsVersion: stats.version,
        references,
        affectedKeys: changes.length,
      };
    await this.store.transact(transaction);
    return this.service.key(identity, id, data.name);
  }
}
