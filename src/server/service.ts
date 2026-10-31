import { z } from "zod";
import { SyncCredentials } from "./sync-credentials";
import { ProjectUpdates, type KeyChange } from "./project-updates";
import { randomUUID } from "node:crypto";
import {
  editChange,
  keyState,
  legacyKeyId,
  type KeyEdit,
  type DeletedKey,
  type EditOrigin,
} from "./key-history";
import { getFileFormat } from "../formats";
import { exportFiles } from "../formats/write";
import {
  advancedKey,
  looksPlural,
  resolveProject,
  readPlural,
  completeMessage,
  validatePlural,
  references,
  pluralSignature,
  exportPlural,
} from "../messages";
import { dataPrefix, cachedView, viewStats } from "./project-data";
import type {
  Bootstrap,
  Identity,
  KeyPage,
  Project,
  ProjectStats,
  Token,
  TranslationKey,
} from "../shared";
import {
  authorize,
  generateToken,
  hashToken,
  HttpError,
  projectRole,
} from "./auth";
import { config } from "./config";
import {
  Conflict,
  getStore,
  type Store,
  type RecordValue,
  type PageOptions,
  type Change,
} from "./store";
import { freshnessView, sourceContexts, stampFreshness } from "./freshness";
import { validateKeyQuality, requireCurrentCopy } from "./translation-quality";
import { McpCredentials } from "./mcp-credentials";
import { mcpAudit } from "./mcp-credentials";
import { translationBatchSchema } from "./mcp-schemas";

import {
  keyNameSchema,
  keySchema,
  projectSchema,
  translationSchema,
} from "../validation";
const now = () => new Date().toISOString();
const value = (record: object): RecordValue => record as RecordValue;
export const emptyStats = (): ProjectStats => ({
  totalKeys: 0,
  byLanguage: {},
  coverage: {},
  namespaces: {},
  version: 1,
  messageVersion: 2,
  outdatedByLanguage: {},
  outdatedKeys: 0,
});
export function indexed(key: TranslationKey): TranslationKey {
  const { resolvedTranslations, referenceErrors, ...raw } = key;
  return {
    ...raw,
    searchText: [
      key.name,
      key.description,
      ...key.tags,
      ...Object.values(key.translations),
    ]
      .join("\n")
      .toLowerCase(),
    populatedLanguages: Object.keys(key.translations)
      .filter((code) => key.translations[code]?.trim())
      .sort(),
    filledLanguages: Object.keys(key.translations)
      .filter(
        (code) =>
          key.translations[code]?.trim() &&
          !key.outdatedLanguages?.includes(code),
      )
      .sort(),
  };
}
export function count(stats: ProjectStats, key: TranslationKey, delta: number) {
  const filled = key.filledLanguages ?? indexed(key).filledLanguages!;
  stats.totalKeys += delta;
  stats.advancedKeys =
    (stats.advancedKeys ?? 0) + (advancedKey(key) ? delta : 0);
  const increment = (map: Record<string, number>, id: string) => {
    map[id] = (map[id] ?? 0) + delta;
    if (!map[id]) delete map[id];
  };
  filled.forEach((code) => increment(stats.byLanguage, code));
  stats.outdatedByLanguage ??= {};
  for (const code of key.outdatedLanguages ?? [])
    increment(stats.outdatedByLanguage, code);
  stats.outdatedKeys =
    (stats.outdatedKeys ?? 0) + (key.outdatedLanguages?.length ? delta : 0);
  increment(stats.coverage, filled.join(",") || "-");
  increment(stats.namespaces, key.namespace || "general");
}
export function completedKeys(stats: ProjectStats, project: Project) {
  return Object.entries(stats.coverage).reduce(
    (sum, [filled, amount]) =>
      sum +
      (project.languages.every((l) => filled.split(",").includes(l.code))
        ? amount
        : 0),
    0,
  );
}

export class KeyloService {
  constructor(private store: Store) {}
  private async currentProject(id: string) {
    const project = await this.store.get<Project>("WORKSPACE", `PROJECT#${id}`);
    if (!project) throw new HttpError(404, "Project not found.");
    return project;
  }
  private async effectiveKeys(project: Project, stats: ProjectStats) {
    const cached = cachedView(this.store, project.id, project, stats);
    if (cached) return cached;
    const keys = await this.store.list<TranslationKey>(
      `PROJECT#${project.id}`,
      `${dataPrefix(project)}KEY#`,
    );
    const latest = await this.store.get<ProjectStats>(
      `PROJECT#${project.id}`,
      `${dataPrefix(project)}STATS`,
    );
    const current = await this.currentProject(project.id);
    if (
      current.version !== project.version ||
      latest?.version !== stats.version
    )
      throw new Conflict();
    try {
      return cachedView(this.store, project.id, project, stats, keys)!;
    } catch (error) {
      throw new HttpError(422, (error as Error).message);
    }
  }
  private async stats(id: string): Promise<ProjectStats> {
    const prefix = dataPrefix(await this.currentProject(id));
    const existing = await this.store.get<ProjectStats>(
      `PROJECT#${id}`,
      `${prefix}STATS`,
    );
    if (existing?.messageVersion === 2) return existing;
    // One-time migration for local workspaces created before paginated keys.
    const initial = emptyStats();
    if (existing) initial.version = existing.version + 1;
    for (const old of await this.store.list<TranslationKey>(
      `PROJECT#${id}`,
      `${prefix}KEY#`,
    )) {
      const next = indexed(old);
      count(initial, next, 1);
      if (!existing)
        try {
          await this.store.put(
            `PROJECT#${id}`,
            `${prefix}KEY#${old.name}`,
            value(next),
            old.version,
          );
        } catch (e) {
          if (!(e instanceof Conflict)) throw e;
        }
    }
    try {
      await this.store.put(
        `PROJECT#${id}`,
        `${prefix}STATS`,
        value(initial),
        existing?.version,
      );
      return initial;
    } catch (e) {
      if (!(e instanceof Conflict)) throw e;
      return (await this.store.get<ProjectStats>(
        `PROJECT#${id}`,
        `${prefix}STATS`,
      ))!;
    }
  }
  private async persistKeys(
    identity: Identity,
    id: string,
    changes: KeyChange[],
    additionalChanges: Change[] = [],
    expectedProject?: Project,
    commitAuthorization?: () => Promise<Change[]>,
    origin: EditOrigin = "browser",
  ) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const project = await this.currentProject(id);
      if (expectedProject && expectedProject.version !== project.version)
        throw new Conflict();
      const prefix = dataPrefix(project);
      const previous = await this.stats(id);
      const next = structuredClone(previous);
      next.version++;
      const lifecycle: Change[] = [];
      for (const change of changes) {
        if (change.next)
          change.next = {
            ...change.next,
            id:
              change.old?.id ??
              change.next.id ??
              (change.old ? legacyKeyId(id, change.old.name) : randomUUID()),
          };
        if (!change.old || !change.next) {
          const name = (change.next ?? change.old)!.name,
            sk = `KEY_GENERATION#${name}`;
          const generation = await this.store.get<{
            version: number;
            lastVersion: number;
          }>(`PROJECT#${id}`, sk);
          if (change.next)
            change.next.version = Math.max(
              change.next.version,
              (generation?.lastVersion ?? 0) + 1,
            );
          lifecycle.push({
            pk: `PROJECT#${id}`,
            sk,
            value: {
              version: (generation?.version ?? 0) + 1,
              lastVersion: (change.next ?? change.old)!.version,
            },
            expectedVersion: generation?.version,
          });
        }
        if (change.old && !change.next) {
          const keyId = change.old.id ?? legacyKeyId(id, change.old.name);
          const priorTrash = await this.store.get<DeletedKey>(
            `PROJECT#${id}`,
            `TRASH#${keyId}`,
          );
          lifecycle.push({
            pk: `PROJECT#${id}`,
            sk: `TRASH#${keyId}`,
            expectedVersion: priorTrash?.version,
            value: {
              version: (priorTrash?.version ?? 0) + 1,
              id: keyId,
              key: keyState({ ...change.old, id: keyId }),
              deletedAt: now(),
              deletedBy: identity.name,
              ttl: Math.floor(Date.now() / 1000) + 30 * 86400,
              searchText: change.old.name.toLowerCase(),
            },
          });
        }
      }
      const graphNeeded =
        (previous.advancedKeys ?? 0) > 0 ||
        changes.some((change) => change.next && advancedKey(change.next));
      const originals = graphNeeded
        ? await this.store.list<TranslationKey>(
            `PROJECT#${id}`,
            `${prefix}KEY#`,
          )
        : changes.flatMap((change) => (change.old ? [change.old] : []));
      const beforeContexts = sourceContexts(originals, project);
      const candidates = new Map(originals.map((key) => [key.name, key]));
      for (const change of changes) {
        if (change.old) candidates.delete(change.old.name);
        if (change.next) {
          const sourceChanged =
            !!change.old &&
            (change.old.translations[project.sourceLanguage] !==
              change.next.translations[project.sourceLanguage] ||
              !!change.old.plural !== !!change.next.plural);
          change.next = {
            ...change.next,
            sourceRevision:
              (change.old?.sourceRevision ?? change.next.sourceRevision ?? 1) +
              (sourceChanged ? 1 : 0),
          };
          candidates.set(change.next.name, change.next);
        }
      }
      const contexts = sourceContexts([...candidates.values()], project);
      for (const change of changes) {
        if (
          change.old &&
          change.translatedLocales?.some(
            (code) => code !== project.sourceLanguage,
          ) &&
          references(change.old.translations[project.sourceLanguage] ?? "")
            .length &&
          !change.expectedSourceContext
        )
          throw new HttpError(
            400,
            "Linked source copy requires expectedSourceContext from the latest key read.",
          );
        if (
          change.expectedSourceContext &&
          change.expectedSourceContext !==
            beforeContexts.get(change.old!.name)?.token
        )
          throw new Conflict();
        if (change.next) {
          change.next = stampFreshness(
            change.old,
            change.next,
            project,
            contexts.get(change.next.name)!,
            change.old ? beforeContexts.get(change.old.name) : undefined,
            change.translatedLocales ??
              (!change.old ? Object.keys(change.next.translations) : []),
          );
          candidates.set(change.next.name, change.next);
        }
      }
      const decorated = new Map(
        freshnessView([...candidates.values()], project).map((key) => [
          key.name,
          key,
        ]),
      );
      for (const change of changes) {
        if (change.next)
          change.next = indexed(decorated.get(change.next.name)!);
        if (change.old)
          count(
            next,
            originals.find((key) => key.name === change.old!.name) ??
              change.old,
            -1,
          );
        if (change.next) count(next, change.next, 1);
      }
      if (graphNeeded) {
        try {
          const affected = new Set(
            changes.map((change) => (change.next ?? change.old)!.name),
          );
          const inbound = new Map<string, Set<string>>();
          for (const key of candidates.values())
            for (const target of Object.values(key.translations).flatMap(
              references,
            )) {
              const names = inbound.get(target) ?? new Set<string>();
              names.add(key.name);
              inbound.set(target, names);
            }
          const queue = [...affected];
          for (let i = 0; i < queue.length; i++)
            for (const name of inbound.get(queue[i]!) ?? [])
              if (!affected.has(name)) {
                affected.add(name);
                queue.push(name);
              }
          resolveProject([...candidates.values()], project, true, affected);
        } catch (error) {
          throw new HttpError(422, (error as Error).message);
        }
      }
      const qualityKeys = graphNeeded
        ? resolveProject([...decorated.values()], project)
        : [...decorated.values()];
      const qualityByName = new Map(qualityKeys.map((key) => [key.name, key]));
      for (const change of changes)
        if (change.next)
          validateKeyQuality(
            qualityByName.get(change.next.name)!,
            project,
            change.translatedLocales ??
              (!change.old ? Object.keys(change.next.translations) : []),
            change.old,
          );
      try {
        await this.store.transact([
          ...(commitAuthorization ? await commitAuthorization() : []),
          ...additionalChanges,
          ...lifecycle,
          ...changes.map((change) =>
            editChange(id, identity, origin, change.old, change.next),
          ),
          {
            pk: "WORKSPACE",
            sk: `PROJECT#${id}`,
            check: true,
            expectedVersion: project.version,
          },
          ...changes.map((c) => ({
            pk: `PROJECT#${id}`,
            sk: `${prefix}KEY#${(c.next ?? c.old)!.name}`,
            value: c.next ? value(c.next) : undefined,
            expectedVersion: c.expectedVersion,
          })),
          {
            pk: `PROJECT#${id}`,
            sk: `${prefix}STATS`,
            value: value(next),
            expectedVersion: previous.version,
          },
        ]);
        return;
      } catch (e) {
        if (!(e instanceof Conflict) || attempt === 7) throw e;
        for (const change of changes) {
          const current = await this.store.get<TranslationKey>(
            `PROJECT#${id}`,
            `${prefix}KEY#${(change.next ?? change.old)!.name}`,
          );
          if (current?.version !== change.expectedVersion) throw new Conflict();
        }
        await new Promise((resolve) =>
          setTimeout(resolve, 10 * 2 ** attempt + Math.random() * 20),
        );
      }
    }
  }
  async bootstrap(identity: Identity): Promise<Bootstrap> {
    const projects = await this.store.list<Project>("WORKSPACE", "PROJECT#");
    return {
      identity,
      authMode: config().authMode,
      projects: projects
        .filter((p) => projectRole(identity, p.id))
        .map((p) => ({ ...p, role: projectRole(identity, p.id)! })),
    };
  }
  async project(identity: Identity, id: string) {
    authorize(identity, id);
    const project = await this.store.get<Project>("WORKSPACE", `PROJECT#${id}`);
    if (!project) throw new HttpError(404, "Project not found.");
    return project;
  }
  async createProject(identity: Identity, input: unknown, importId?: string) {
    if (!identity.admin)
      throw new HttpError(403, "Only a workspace admin can create projects.");
    const data = projectSchema.parse(input);
    const project: Project = {
      ...data,
      version: 1,
      createdAt: now(),
      updatedAt: now(),
      ...(importId ? { importId, importedBy: identity.sub } : {}),
    };
    await this.store.transact([
      { pk: "WORKSPACE", sk: `PROJECT#${project.id}`, value: value(project) },
      { pk: `PROJECT#${project.id}`, sk: "STATS", value: value(emptyStats()) },
    ]);
    return project;
  }
  async updateProject(identity: Identity, id: string, input: unknown) {
    authorize(identity, id, "manager");
    const { version, ...data } = z
      .looseObject({ version: z.number().int().positive() })
      .parse(input);
    const project = await this.project(identity, id);
    const parsed = projectSchema.parse({ ...data, id });
    // Removing a locale is deliberately unsupported: it would silently orphan translations.
    if (
      project.languages.some(
        (l) => !parsed.languages.some((n) => n.code === l.code),
      )
    )
      throw new HttpError(400, "Existing project languages cannot be removed.");
    if (parsed.sourceLanguage !== project.sourceLanguage)
      throw new HttpError(
        400,
        "The source language cannot be changed after creation.",
      );
    const next = {
      ...project,
      ...parsed,
      version: version + 1,
      updatedAt: now(),
    };
    await this.store.put("WORKSPACE", `PROJECT#${id}`, value(next), version);
    return next;
  }
  async keys(identity: Identity, id: string) {
    const project = await this.project(identity, id);
    return this.store.list<TranslationKey>(
      `PROJECT#${id}`,
      `${dataPrefix(project)}KEY#`,
    );
  }
  async keyPage(
    identity: Identity,
    id: string,
    options: PageOptions,
  ): Promise<KeyPage> {
    const project = await this.project(identity, id);
    const stats = await this.stats(id);
    if (stats.advancedKeys) {
      const keys = await this.effectiveKeys(project, stats);
      const languages = identity.mcp
        ? (options.languages ?? identity.mcp.languages).filter((code) =>
            identity.mcp!.languages.includes(code),
          )
        : project.languages.map((locale) => locale.code);
      let after = "";
      if (options.cursor) {
        try {
          const parsed = JSON.parse(
            Buffer.from(options.cursor, "base64url").toString(),
          );
          if (
            parsed.pk !== `PROJECT#${id}` ||
            typeof parsed.sk !== "string" ||
            !parsed.sk.startsWith(`${dataPrefix(project)}KEY#`)
          )
            throw new Error();
          after = parsed.sk.slice(`${dataPrefix(project)}KEY#`.length);
        } catch {
          throw new HttpError(400, "Invalid pagination cursor.");
        }
      }
      const filtered = keys
        .filter(
          (key) =>
            (!after || key.name > after) &&
            (!options.namespace || key.namespace === options.namespace) &&
            (!options.query ||
              [
                key.name,
                key.description,
                ...key.tags,
                ...Object.values(key.translations),
                ...Object.values(key.resolvedTranslations ?? {}),
              ]
                .join("\n")
                .toLowerCase()
                .includes(options.query.toLowerCase())) &&
            (!options.status ||
              (options.status === "outdated"
                ? languages.some((code) =>
                    key.outdatedLanguages?.includes(code),
                  )
                : options.status === "missing"
                  ? languages.some(
                      (code) =>
                        !completeMessage(
                          key.resolvedTranslations?.[code] ??
                            key.translations[code] ??
                            "",
                          project.languages.find(
                            (locale) => locale.code === code,
                          )!,
                          !!key.plural,
                        ) || !!key.referenceErrors?.[code],
                    )
                  : (options.status === "complete") ===
                    languages.every(
                      (code) =>
                        !key.outdatedLanguages?.includes(code) &&
                        completeMessage(
                          key.resolvedTranslations?.[code] ??
                            key.translations[code] ??
                            "",
                          project.languages.find(
                            (locale) => locale.code === code,
                          )!,
                          !!key.plural,
                        ) &&
                        !key.referenceErrors?.[code],
                    ))),
        )
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const items = filtered.slice(0, options.limit);
      return {
        items: items.map(({ searchText, filledLanguages, ...key }) => key),
        stats: viewStats(stats, keys, project),
        ...(filtered.length > options.limit
          ? {
              nextCursor: Buffer.from(
                JSON.stringify({
                  pk: `PROJECT#${id}`,
                  sk: `${dataPrefix(project)}KEY#${items.at(-1)!.name}`,
                }),
              ).toString("base64url"),
            }
          : {}),
      };
    }
    const page = await this.store.page<TranslationKey>(
      `PROJECT#${id}`,
      `${dataPrefix(project)}KEY#`,
      {
        ...options,
        languages: identity.mcp
          ? (options.languages ?? identity.mcp.languages).filter((code) =>
              identity.mcp!.languages.includes(code),
            )
          : project.languages.map((l) => l.code),
      },
    );
    return {
      ...page,
      items: freshnessView(page.items, project).map(
        ({ searchText, filledLanguages, ...key }) => key,
      ),
      stats,
    };
  }
  async summary(identity: Identity, id: string) {
    const project = await this.project(identity, id);
    const stats = await this.stats(id);
    return stats.advancedKeys
      ? viewStats(stats, await this.effectiveKeys(project, stats), project)
      : stats;
  }
  async key(identity: Identity, id: string, name: string) {
    const project = await this.project(identity, id);
    keyNameSchema.parse(name);
    const key = await this.store.get<TranslationKey>(
      `PROJECT#${id}`,
      `${dataPrefix(project)}KEY#${name}`,
    );
    if (!key) throw new HttpError(404, "Key not found.");
    const stats = await this.stats(id);
    if (stats.advancedKeys)
      return (await this.effectiveKeys(project, stats)).find(
        (item) => item.name === name,
      )!;
    return freshnessView([key], project)[0]!;
  }
  async setMcpTranslations(identity: Identity, id: string, input: unknown) {
    const project = await this.project(identity, id);
    const grant = identity.mcp;
    if (!grant || grant.projectId !== id)
      throw new HttpError(403, "An MCP translation credential is required.");
    const data = translationBatchSchema.parse(input);
    if (
      new Set(data.updates.map((update) => update.key)).size !==
      data.updates.length
    )
      throw new HttpError(400, "Each key may occur only once in a batch.");
    if (data.overwriteExisting && !grant.allowOverwrite)
      throw new HttpError(
        403,
        "This credential can only fill missing translations.",
      );
    const changes = [];
    for (const update of data.updates) {
      const previous = await this.key(identity, id, update.key);
      if (previous.version !== update.expectedVersion) throw new Conflict();
      this.validateTranslations(project, update.translations);
      for (const [language, text] of Object.entries(update.translations)) {
        if (
          language === project.sourceLanguage ||
          !grant.languages.includes(language)
        )
          throw new HttpError(
            403,
            "Only the credential's selected target languages can be translated.",
          );
        if (!text.trim())
          throw new HttpError(
            400,
            "MCP cannot clear translations. Provide non-empty text.",
          );
        const before = readPlural(previous.translations[language] ?? "");
        const templateText = previous.translations[language]?.trim()
          ? previous.translations[language]!
          : (previous.translations[project.sourceLanguage] ??
            Object.values(previous.translations).find((value) =>
              value.trim(),
            ) ??
            "");
        const after = readPlural(text);
        if (
          previous.plural &&
          !completeMessage(
            text,
            project.languages.find((locale) => locale.code === language)!,
            true,
          )
        )
          throw new HttpError(
            400,
            "Provide all required plural forms with non-empty copy.",
          );
        if (
          previous.plural &&
          templateText.trim() &&
          pluralSignature(templateText) !== pluralSignature(text)
        )
          throw new HttpError(
            403,
            "MCP cannot change plural variables, type or offset.",
          );
        const replaces =
          previous.plural && before && after
            ? Object.entries(before.forms).some(
                ([form, value]) => value.trim() && after.forms[form] !== value,
              )
            : !!previous.translations[language]?.trim() &&
              previous.translations[language] !== text;
        if (replaces && !data.overwriteExisting)
          throw new HttpError(
            409,
            "A translation already exists. Re-read the key; replacement requires overwrite permission and overwriteExisting: true.",
          );
      }
      const translations = { ...previous.translations, ...update.translations };
      keySchema.parse({
        name: previous.name,
        description: previous.description,
        namespace: previous.namespace,
        tags: previous.tags,
        translations,
        plural: previous.plural,
      });
      changes.push({
        old: previous,
        next: indexed({
          ...previous,
          translations,
          version: previous.version + 1,
          updatedAt: now(),
          updatedBy: identity.name,
        }),
        expectedVersion: update.expectedVersion,
        translatedLocales: Object.keys(update.translations),
        expectedSourceContext: update.expectedSourceContext,
      });
    }
    await this.persistKeys(
      identity,
      id,
      changes,
      [
        mcpAudit("mcp.translations_saved", identity.sub, id, {
          credential: grant.credentialId,
          updates: data.updates.map((update) => ({
            key: update.key,
            languages: Object.keys(update.translations),
          })),
        }),
      ],
      project,
      () => new McpCredentials(this.store).writeGuards(identity, id),
      "mcp",
    );
    return {
      saved: changes.map((change) => ({
        key: change.next.name,
        version: change.next.version,
      })),
    };
  }
  private validateTranslations(
    project: Project,
    translations: Record<string, string>,
  ) {
    const locales = new Set(project.languages.map((l) => l.code));
    if (Object.keys(translations).some((code) => !locales.has(code)))
      throw new HttpError(
        400,
        "A translation uses a language that is not enabled for this project.",
      );
  }
  async createKey(identity: Identity, id: string, input: unknown) {
    authorize(identity, id, "manager");
    const project = await this.project(identity, id);
    let data = keySchema.parse(input);
    if (
      data.plural === undefined &&
      Object.values(data.translations).some(looksPlural)
    )
      data = keySchema.parse({ ...data, plural: true });
    this.validateTranslations(project, data.translations);
    const key: TranslationKey = indexed({
      ...data,
      version: 1,
      createdAt: now(),
      updatedAt: now(),
      updatedBy: identity.name,
    });
    await this.persistKeys(identity, id, [{ next: key }], [], project);
    return this.key(identity, id, key.name);
  }
  async updateKey(
    identity: Identity,
    id: string,
    name: string,
    input: unknown,
  ) {
    if (identity.mcp)
      throw new HttpError(403, "Use the scoped MCP translation tool.");
    const project = await this.project(identity, id);
    const parsed = z
      .object({
        version: z.number().int().positive(),
        expectedSourceContext: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        translations: translationSchema,
        description: z.string().max(1000).optional(),
        tags: z.array(z.string().trim().min(1).max(30)).max(12).optional(),
        namespace: z.string().trim().max(60).optional(),
        plural: z.boolean().optional(),
      })
      .strict()
      .parse(input);
    const previous = await this.store.get<TranslationKey>(
      `PROJECT#${id}`,
      `${dataPrefix(project)}KEY#${name}`,
    );
    if (!previous) throw new HttpError(404, "Key not found.");
    this.validateTranslations(project, parsed.translations);
    if (projectRole(identity, id) === "user") {
      if (
        (parsed.translations[project.sourceLanguage] !== undefined &&
          parsed.translations[project.sourceLanguage] !==
            previous.translations[project.sourceLanguage]) ||
        parsed.description !== undefined ||
        parsed.tags !== undefined ||
        parsed.namespace !== undefined ||
        parsed.plural !== undefined
      )
        throw new HttpError(
          403,
          "Users can edit target translations. A manager can edit source copy and key details.",
        );
    }
    if (projectRole(identity, id) === "user" && previous.plural) {
      for (const [code, text] of Object.entries(parsed.translations)) {
        if (!text.trim()) continue;
        try {
          validatePlural(text);
        } catch (error) {
          throw new HttpError(400, (error as Error).message);
        }
        const template = previous.translations[code]?.trim()
          ? previous.translations[code]!
          : (previous.translations[project.sourceLanguage] ?? "");
        if (
          template.trim() &&
          pluralSignature(template) !== pluralSignature(text)
        )
          throw new HttpError(
            403,
            "A manager can change plural variables, type or offset.",
          );
      }
    }
    const { version, translations, expectedSourceContext, ...metadata } =
      parsed;
    const key = indexed({
      ...previous,
      ...metadata,
      translations: { ...previous.translations, ...translations },
      version: version + 1,
      updatedAt: now(),
      updatedBy: identity.name,
    });
    keySchema.parse({
      name: key.name,
      description: key.description,
      namespace: key.namespace,
      tags: key.tags,
      translations: key.translations,
      plural: key.plural,
    });
    await this.persistKeys(
      identity,
      id,
      [
        {
          old: previous,
          next: key,
          expectedVersion: version,
          translatedLocales: Object.keys(translations),
          expectedSourceContext,
        },
      ],
      [],
      project,
    );
    return this.key(identity, id, key.name);
  }
  async deleteKey(
    identity: Identity,
    id: string,
    name: string,
    version: number,
  ) {
    authorize(identity, id, "manager");
    const project = await this.project(identity, id);
    const old = await this.store.get<TranslationKey>(
      `PROJECT#${id}`,
      `${dataPrefix(project)}KEY#${name}`,
    );
    if (!old) throw new HttpError(404, "Key not found.");
    await this.persistKeys(
      identity,
      id,
      [{ old, expectedVersion: version }],
      [],
      project,
    );
  }
  private updates(identity: Identity, id: string) {
    return new ProjectUpdates(
      this.store,
      this,
      (changes, extra, project, origin) =>
        this.persistKeys(
          identity,
          id,
          changes,
          extra,
          project,
          identity.sync
            ? () => new SyncCredentials(this.store).writeGuards(identity)
            : undefined,
          origin,
        ),
    );
  }
  async previewUpdate(identity: Identity, id: string, input: unknown) {
    return this.updates(identity, id).preview(
      identity,
      id,
      input,
      identity.sync ? "sync" : "import",
    );
  }
  async applyUpdate(identity: Identity, id: string, plan: string) {
    return this.updates(identity, id).apply(identity, id, plan);
  }
  async keyHistory(
    identity: Identity,
    id: string,
    name: string,
    options: PageOptions,
  ) {
    if (identity.mcp || identity.tokenProject)
      throw new HttpError(403, "Sign in to view translation history.");
    const key = await this.key(identity, id, name);
    return this.store.page<KeyEdit>(
      `PROJECT#${id}`,
      `KEY_HISTORY#${key.id ?? legacyKeyId(id, name)}#`,
      { limit: options.limit, cursor: options.cursor, reverse: true },
    );
  }
  async restoreTranslation(
    identity: Identity,
    id: string,
    name: string,
    eventId: string,
    input: unknown,
  ) {
    if (identity.mcp || identity.tokenProject)
      throw new HttpError(403, "Sign in to restore translations.");
    const data = z
      .object({
        version: z.number().int().positive(),
        language: z.string().min(2).max(35),
        side: z.enum(["before", "after"]),
        expectedSourceContext: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
      })
      .strict()
      .parse(input);
    const project = await this.project(identity, id),
      current = await this.key(identity, id, name);
    if (current.version !== data.version) throw new Conflict();
    if (!project.languages.some((locale) => locale.code === data.language))
      throw new HttpError(400, "Unknown language.");
    if (data.language === project.sourceLanguage)
      authorize(identity, id, "manager");
    const event = await this.store.get<KeyEdit>(
      `PROJECT#${id}`,
      `KEY_HISTORY#${current.id ?? legacyKeyId(id, name)}#${z
        .string()
        .max(80)
        .regex(/^[0-9TZ:._a-f-]+$/)
        .parse(eventId)}`,
    );
    const state = event?.[data.side];
    if (
      !state ||
      state.name !== name ||
      !Object.hasOwn(state.translations, data.language)
    )
      throw new HttpError(404, "Historical translation not found.");
    const translationSources = { ...current.translationSources };
    if (state.translationSources?.[data.language])
      translationSources[data.language] =
        state.translationSources[data.language]!;
    else delete translationSources[data.language];
    const next = indexed({
      ...current,
      translations: {
        ...current.translations,
        [data.language]: state.translations[data.language]!,
      },
      translationSources,
      version: current.version + 1,
      updatedAt: now(),
      updatedBy: identity.name,
    });
    keySchema.parse({
      name: next.name,
      namespace: next.namespace,
      description: next.description,
      tags: next.tags,
      plural: next.plural,
      translations: next.translations,
    });
    // Preserve the historical source anchor. Restoring old text cannot certify it for new source copy.
    await this.persistKeys(
      identity,
      id,
      [
        {
          old: current,
          next,
          expectedVersion: current.version,
          translatedLocales: [],
          expectedSourceContext: data.expectedSourceContext,
        },
      ],
      [],
      project,
      undefined,
      "restore",
    );
    return this.key(identity, id, name);
  }
  async deletedKeys(identity: Identity, id: string, options: PageOptions) {
    authorize(identity, id, "manager");
    await this.project(identity, id);
    const page = await this.store.page<DeletedKey>(`PROJECT#${id}`, "TRASH#", {
      limit: options.limit,
      cursor: options.cursor,
    });
    return {
      ...page,
      items: page.items
        .filter((item) => item.ttl > Date.now() / 1000)
        .map(({ key, ...item }) => ({
          ...item,
          name: key.name,
          languages: Object.keys(key.translations),
        })),
    };
  }
  async restoreDeletedKey(
    identity: Identity,
    id: string,
    keyId: string,
    input: unknown,
  ) {
    authorize(identity, id, "manager");
    z.uuid().parse(keyId);
    const { version } = z
      .object({ version: z.number().int().positive() })
      .strict()
      .parse(input);
    const project = await this.project(identity, id),
      trash = await this.store.get<DeletedKey>(
        `PROJECT#${id}`,
        `TRASH#${keyId}`,
      );
    if (!trash || trash.ttl <= Date.now() / 1000)
      throw new HttpError(404, "Deleted key is no longer recoverable.");
    if (trash.version !== version) throw new Conflict();
    const next = indexed({
      ...trash.key,
      id: keyId,
      version: trash.key.version + 1,
      updatedAt: now(),
      updatedBy: identity.name,
    });
    keySchema.parse({
      name: next.name,
      namespace: next.namespace,
      description: next.description,
      tags: next.tags,
      plural: next.plural,
      translations: next.translations,
    });
    await this.persistKeys(
      identity,
      id,
      [{ next, translatedLocales: [] }],
      [{ pk: `PROJECT#${id}`, sk: `TRASH#${keyId}`, expectedVersion: version }],
      project,
      undefined,
      "recovery",
    );
    return this.key(identity, id, next.name);
  }
  async startImport(identity: Identity, input: unknown) {
    if (!identity.admin)
      throw new HttpError(403, "Only a workspace admin can import projects.");
    const { importId, project } = z
      .object({ importId: z.uuid(), project: projectSchema })
      .strict()
      .parse(input);
    const existing = await this.store.get<Project>(
      "WORKSPACE",
      `PROJECT#${project.id}`,
    );
    if (existing) {
      if (
        existing.importId === importId &&
        existing.importedBy === identity.sub
      )
        return existing;
      throw new HttpError(
        409,
        "This project ID is already in use. Choose a new ID to preserve the existing project.",
      );
    }
    return this.createProject(identity, project, importId);
  }
  async importBatch(identity: Identity, id: string, input: unknown) {
    if (!identity.admin)
      throw new HttpError(403, "Only a workspace admin can import projects.");
    const data = z
      .object({ importId: z.uuid(), keys: z.array(keySchema).min(1).max(20) })
      .strict()
      .parse(input);
    const project = await this.project(identity, id);
    if (
      project.importId !== data.importId ||
      project.importedBy !== identity.sub
    )
      throw new HttpError(
        403,
        "This import does not belong to the current project and user.",
      );
    if (new Set(data.keys.map((k) => k.name)).size !== data.keys.length)
      throw new HttpError(400, "Duplicate keys in import batch.");
    const changes: { next: TranslationKey }[] = [];
    let skipped = 0;
    for (const item of data.keys) {
      if (
        item.plural === undefined &&
        Object.values(item.translations).some(looksPlural)
      )
        item.plural = true;
      keySchema.parse(item);
      this.validateTranslations(project, item.translations);
      const existing = await this.store.get<TranslationKey>(
        `PROJECT#${id}`,
        `${dataPrefix(project)}KEY#${item.name}`,
      );
      if (existing) {
        if (existing.importId !== data.importId)
          throw new HttpError(
            409,
            `Key ${item.name} already exists and will not be overwritten.`,
          );
        skipped++;
        continue;
      }
      changes.push({
        next: indexed({
          ...item,
          version: 1,
          createdAt: now(),
          updatedAt: now(),
          updatedBy: identity.name,
          importId: data.importId,
        }),
      });
    }
    if (changes.length)
      await this.persistKeys(
        identity,
        id,
        changes,
        [],
        project,
        undefined,
        "import",
      );
    return { imported: changes.length, skipped };
  }
  async tokens(identity: Identity, id: string) {
    authorize(identity, id, "manager");
    await this.project(identity, id);
    return (await this.store.list<Token>(`PROJECT#${id}`, "TOKEN#")).map(
      ({ hash, ...token }) => ({ ...token, id: hash }),
    );
  }
  async createToken(identity: Identity, id: string, input: unknown) {
    authorize(identity, id, "manager");
    await this.project(identity, id);
    const data = z
      .object({
        name: z.string().trim().min(1).max(80),
        expiresInDays: z.number().int().min(1).max(365).default(90),
      })
      .strict()
      .parse(input);
    const secret = generateToken(id);
    const token: Token = {
      hash: hashToken(secret),
      name: data.name,
      prefix: secret.slice(0, secret.indexOf(".") + 9),
      expiresAt: new Date(
        Date.now() + data.expiresInDays * 86400000,
      ).toISOString(),
      createdAt: now(),
      createdBy: identity.name,
      version: 1,
    };
    await this.store.put(`PROJECT#${id}`, `TOKEN#${token.hash}`, value(token));
    return { secret, ...token, hash: undefined };
  }
  async revokeToken(identity: Identity, id: string, hash: string) {
    authorize(identity, id, "manager");
    await this.project(identity, id);
    if (!/^[a-f0-9]{64}$/.test(hash))
      throw new HttpError(400, "Invalid token ID.");
    await this.store.remove(`PROJECT#${id}`, `TOKEN#${hash}`, 1);
  }
  async export(
    identity: Identity,
    id: string,
    locales: string[],
    format: string,
    fallback: boolean,
    requireCurrent = false,
  ) {
    const project = await this.project(identity, id);
    try {
      getFileFormat(format);
    } catch {
      throw new HttpError(400, "Unsupported export format.");
    }
    const selected = locales.length
      ? [...new Set(locales)]
      : project.languages.map((l) => l.code);
    if (selected.some((c) => !project.languages.some((l) => l.code === c)))
      throw new HttpError(400, "Unknown export language.");
    const rawStats = await this.stats(id);
    const keys = (
      rawStats.advancedKeys
        ? await this.effectiveKeys(project, rawStats)
        : await this.keys(identity, id)
    ).sort((a, b) => a.name.localeCompare(b.name, "en"));
    if (requireCurrent) requireCurrentCopy(keys, project, selected);
    const result: Record<string, unknown> = Object.create(null);
    let size = 0;
    for (const locale of selected) {
      const translations: Record<string, unknown> = Object.create(null);
      for (const key of keys) {
        if (key.referenceErrors?.[locale])
          throw new HttpError(422, key.referenceErrors[locale]);
        if (
          fallback &&
          key.referenceErrors?.[project.sourceLanguage] &&
          !completeMessage(
            key.resolvedTranslations?.[locale] ??
              key.translations[locale] ??
              "",
            project.languages.find((item) => item.code === locale)!,
            !!key.plural,
          )
        )
          throw new HttpError(
            422,
            key.referenceErrors[project.sourceLanguage]!,
          );
        const values = key.resolvedTranslations ?? key.translations;
        let text = values[locale]?.trim()
          ? values[locale]!
          : fallback
            ? (values[project.sourceLanguage] ?? "")
            : "";
        if (key.plural)
          text = exportPlural(
            values[locale] ?? "",
            project.languages.find((item) => item.code === locale)!,
            values[project.sourceLanguage] ?? "",
            fallback,
          );
        size += new TextEncoder().encode(key.name + text).length;
        if (size > 10 * 1024 * 1024)
          throw new HttpError(
            413,
            "Export exceeds 10 MB. Export fewer languages or split the project.",
          );
        if (format === "nested") {
          let target = translations;
          const segments = key.name.split(".");
          for (const segment of segments.slice(0, -1)) {
            if (typeof target[segment] === "string")
              throw new HttpError(
                422,
                `Nested export collision at ${key.name}. Use flat JSON.`,
              );
            target[segment] ??= Object.create(null);
            target = target[segment] as Record<string, unknown>;
          }
          const last = segments.at(-1)!;
          if (target[last] !== undefined)
            throw new HttpError(
              422,
              `Nested export collision at ${key.name}. Use flat JSON.`,
            );
          target[last] = text;
        } else translations[key.name] = text;
      }
      result[locale] = translations;
    }
    try {
      const source = new Map(
        keys.map((key) => [
          key.name,
          (key.resolvedTranslations ?? key.translations)[
            project.sourceLanguage
          ] ?? "",
        ]),
      );
      const files = exportFiles(result, format, project.sourceLanguage, source);
      return { project: id, format, translations: result, files };
    } catch (error) {
      throw new HttpError(422, (error as Error).message);
    }
  }
}
export async function service() {
  return new KeyloService(await getStore());
}
