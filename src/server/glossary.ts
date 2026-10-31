import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { canonicalJSON } from "../canonical-json";
import {
  glossaryTermSchema,
  glossaryReadSchema,
  termIdentity,
  matchingTermIds,
  type GlossaryTerm,
} from "../glossary";
import type { Identity, Project } from "../shared";
import { authorize } from "./auth";
import { HttpError } from "./errors";
import { Conflict, type Change, type Store } from "./store";
import { mcpAudit } from "./mcp-credentials";
type Meta = { version: number; count: number };
type Receipt = {
  version: number;
  actor: string;
  hash: string;
  added: number;
  skipped: number;
  ttl: number;
};
const idSchema = z.uuid();
const record = (term: GlossaryTerm) =>
  term as GlossaryTerm & { [key: string]: unknown };
const pk = (id: string) => `PROJECT#${id}`;
const actor = (identity: Identity) => identity.principalId ?? identity.sub;
const order = (term: GlossaryTerm) =>
  `${termIdentity(term.source)}\u0000${term.id}`;
const cache = new WeakMap<
  Store,
  Map<
    string,
    { version: number; at: number; bytes: number; terms: GlossaryTerm[] }
  >
>();
export class Glossary {
  constructor(readonly store: Store) {}
  private async project(identity: Identity, id: string, write = false) {
    if (
      identity.tokenProject ||
      identity.sync ||
      (write && identity.mcp) ||
      (identity.mcp && identity.mcp.projectId !== id)
    )
      throw new HttpError(
        403,
        "This credential cannot access glossary management.",
      );
    authorize(identity, id, write ? "manager" : "user");
    const project = await this.store.get<Project>("WORKSPACE", `PROJECT#${id}`);
    if (!project) throw new HttpError(404, "Project not found.");
    return project;
  }
  private async state(id: string) {
    const meta = await this.store.get<Meta>(pk(id), "GLOSSARY_META");
    let entries = cache.get(this.store);
    if (!entries) {
      entries = new Map();
      cache.set(this.store, entries);
    }
    const cached = entries.get(id);
    if (
      cached &&
      cached.version === (meta?.version ?? 0) &&
      Date.now() - cached.at < 30000
    )
      return { meta, terms: cached.terms };
    const terms = await this.store.list<GlossaryTerm>(pk(id), "GLOSSARY_TERM#");
    const bytes = Buffer.byteLength(JSON.stringify(terms));
    entries.delete(id);
    for (const [key, entry] of entries)
      if (Date.now() - entry.at >= 30000) entries.delete(key);
    let size = [...entries.values()].reduce(
      (sum, entry) => sum + entry.bytes,
      0,
    );
    while (entries.size && size + bytes > 8 * 1024 * 1024) {
      const key = entries.keys().next().value!;
      size -= entries.get(key)!.bytes;
      entries.delete(key);
    }
    if (bytes <= 8 * 1024 * 1024)
      entries.set(id, {
        version: meta?.version ?? 0,
        at: Date.now(),
        bytes,
        terms,
      });
    return { meta, terms };
  }
  private validate(project: Project, term: z.infer<typeof glossaryTermSchema>) {
    for (const code of Object.keys(term.translations))
      if (
        code === project.sourceLanguage ||
        !project.languages.some((locale) => locale.code === code)
      )
        throw new HttpError(
          400,
          "Glossary translations must use configured target languages.",
        );
  }
  async list(identity: Identity, id: string, input: unknown) {
    const project = await this.project(identity, id),
      data = glossaryReadSchema.parse(input);
    if (
      data.language &&
      (!project.languages.some(
        (locale) =>
          locale.code === data.language &&
          locale.code !== project.sourceLanguage,
      ) ||
        (identity.mcp && !identity.mcp.languages.includes(data.language)))
    )
      throw new HttpError(
        403,
        "Target language is outside the permitted glossary scope.",
      );
    const languages = (
      data.language
        ? [data.language]
        : (identity.mcp?.languages ??
          project.languages.map((locale) => locale.code))
    ).filter(
      (code) =>
        code !== project.sourceLanguage &&
        project.languages.some((locale) => locale.code === code),
    );
    const { terms } = await this.state(id);
    const matched =
      data.text === undefined
        ? undefined
        : matchingTermIds(data.text, terms, project.sourceLanguage);
    const visible = terms.map((term) => ({
      ...term,
      translations: Object.fromEntries(
        Object.entries(term.translations).filter(([code]) =>
          languages.includes(code),
        ),
      ),
    }));
    const query = termIdentity(data.query);
    const filtered = visible
      .filter(
        (term) =>
          (!matched || matched.has(term.id)) &&
          (!query ||
            termIdentity(
              [
                term.source,
                term.notes,
                ...Object.values(term.translations),
              ].join("\n"),
            ).includes(query)),
      )
      .sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));
    let after = "";
    if (data.cursor) {
      try {
        const parsed = JSON.parse(
          Buffer.from(data.cursor, "base64url").toString(),
        );
        if (
          parsed.project !== id ||
          typeof parsed.after !== "string" ||
          parsed.after.length > 600
        )
          throw Error();
        after = parsed.after;
      } catch {
        throw new HttpError(400, "Invalid glossary cursor.");
      }
    }
    const page = filtered.filter((term) => !after || order(term) > after),
      items = page.slice(0, data.limit);
    return {
      items,
      total: filtered.length,
      ...(page.length > items.length
        ? {
            nextCursor: Buffer.from(
              JSON.stringify({ project: id, after: order(items.at(-1)!) }),
            ).toString("base64url"),
          }
        : {}),
    };
  }
  private async mutate<T>(
    identity: Identity,
    id: string,
    work: (
      project: Project,
      meta: Meta | undefined,
      terms: GlossaryTerm[],
    ) => Promise<
      | {
          changes: Change[];
          count: number;
          result: T;
          action: string;
          details: Record<string, unknown>;
        }
      | { replay: T }
    >,
  ): Promise<T> {
    for (let attempt = 0; attempt < 6; attempt++) {
      const project = await this.project(identity, id, true),
        { meta, terms } = await this.state(id);
      const built = await work(project, meta, terms);
      if ("replay" in built) return built.replay;
      if (built.count > 1000)
        throw new HttpError(
          413,
          "A project glossary supports up to 1,000 terms.",
        );
      try {
        await this.store.transact([
          {
            pk: "WORKSPACE",
            sk: `PROJECT#${id}`,
            check: true,
            expectedVersion: project.version,
          },
          {
            pk: pk(id),
            sk: "GLOSSARY_META",
            expectedVersion: meta?.version,
            value: { version: (meta?.version ?? 0) + 1, count: built.count },
          },
          ...built.changes,
          mcpAudit(built.action, actor(identity), id, built.details),
        ]);
        return built.result;
      } catch (error) {
        if (!(error instanceof Conflict) || attempt === 5) throw error;
        cache.get(this.store)?.delete(id);
      }
    }
    throw new Conflict();
  }
  async save(identity: Identity, id: string, input: unknown, termId?: string) {
    const version = termId
      ? z.looseObject({ version: z.number().int().positive() }).parse(input)
          .version
      : undefined;
    const supplied = termId
      ? Object.fromEntries(
          Object.entries(input as object).filter(([key]) => key !== "version"),
        )
      : input;
    if (termId) idSchema.parse(termId);
    return this.mutate(identity, id, async (project, meta, terms) => {
      const previous = termId
        ? terms.find((term) => term.id === termId)
        : undefined;
      if (termId && !previous)
        throw new HttpError(404, "Glossary term not found.");
      if (previous && previous.version !== version) throw new Conflict();
      const content = glossaryTermSchema.parse(
        previous
          ? {
              source: previous.source,
              notes: previous.notes,
              caseSensitive: previous.caseSensitive,
              translations: Object.fromEntries(
                Object.entries(previous.translations).filter(([code]) =>
                  project.languages.some((locale) => locale.code === code),
                ),
              ),
              ...(supplied as Record<string, unknown>),
            }
          : supplied,
      );
      this.validate(project, content);
      if (
        terms.some(
          (term) =>
            term.id !== termId &&
            termIdentity(term.source) === termIdentity(content.source),
        )
      )
        throw new HttpError(
          409,
          "This source term already exists in the glossary.",
        );
      const timestamp = new Date().toISOString();
      const term: GlossaryTerm = {
        ...content,
        translations: {
          ...Object.fromEntries(
            Object.entries(previous?.translations ?? {}).filter(
              ([code]) =>
                !project.languages.some((locale) => locale.code === code),
            ),
          ),
          ...content.translations,
        },
        id: previous?.id ?? randomUUID(),
        version: (previous?.version ?? 0) + 1,
        createdAt: previous?.createdAt ?? timestamp,
        updatedAt: timestamp,
        updatedBy: identity.name,
      };
      return {
        changes: [
          {
            pk: pk(id),
            sk: `GLOSSARY_TERM#${term.id}`,
            expectedVersion: previous?.version,
            value: record(term),
          },
        ],
        count: (meta?.count ?? terms.length) + (previous ? 0 : 1),
        result: term,
        action: previous ? "glossary.updated" : "glossary.created",
        details: { term: term.id },
      };
    });
  }
  async remove(
    identity: Identity,
    id: string,
    termId: string,
    version: number,
  ) {
    idSchema.parse(termId);
    z.number().int().positive().parse(version);
    await this.mutate(identity, id, async (_project, meta, terms) => {
      const term = terms.find((term) => term.id === termId);
      if (!term) throw new HttpError(404, "Glossary term not found.");
      if (term.version !== version) throw new Conflict();
      return {
        changes: [
          {
            pk: pk(id),
            sk: `GLOSSARY_TERM#${term.id}`,
            expectedVersion: version,
          },
        ],
        count: (meta?.count ?? terms.length) - 1,
        result: undefined,
        action: "glossary.deleted",
        details: { term: term.id },
      };
    });
  }
  async import(identity: Identity, id: string, input: unknown) {
    const data = z
      .object({
        batchId: z.uuid(),
        sourceLanguage: z.string(),
        terms: z.array(glossaryTermSchema).min(1).max(20),
      })
      .strict()
      .parse(input);
    const hash = createHash("sha256").update(canonicalJSON(data)).digest("hex");
    return this.mutate<{ added: number; skipped: number; replayed: boolean }>(
      identity,
      id,
      async (project, meta, existing) => {
        if (data.sourceLanguage !== project.sourceLanguage)
          throw new HttpError(
            400,
            "Glossary source language must match this project.",
          );
        const prior = await this.store.get<Receipt>(
          pk(id),
          `GLOSSARY_IMPORT#${data.batchId}`,
        );
        if (prior) {
          if (
            prior.actor !== actor(identity) ||
            prior.hash !== hash ||
            prior.ttl <= Date.now() / 1000
          )
            throw new HttpError(
              409,
              "This glossary import receipt cannot be reused. Preview the file again.",
            );
          return {
            replay: {
              added: prior.added,
              skipped: prior.skipped,
              replayed: true,
            },
          };
        }
        const names = new Set<string>(),
          occupied = new Set(existing.map((term) => termIdentity(term.source))),
          timestamp = new Date().toISOString(),
          additions: GlossaryTerm[] = [];
        for (const term of data.terms) {
          this.validate(project, term);
          const name = termIdentity(term.source);
          if (names.has(name))
            throw new HttpError(400, "Duplicate source terms in import batch.");
          names.add(name);
          if (!occupied.has(name))
            additions.push({
              ...term,
              id: randomUUID(),
              version: 1,
              createdAt: timestamp,
              updatedAt: timestamp,
              updatedBy: identity.name,
            });
        }
        const receipt: Receipt = {
          version: 1,
          actor: actor(identity),
          hash,
          added: additions.length,
          skipped: data.terms.length - additions.length,
          ttl: Math.floor(Date.now() / 1000) + 86400,
        };
        return {
          changes: [
            ...additions.map((term) => ({
              pk: pk(id),
              sk: `GLOSSARY_TERM#${term.id}`,
              value: record(term),
            })),
            {
              pk: pk(id),
              sk: `GLOSSARY_IMPORT#${data.batchId}`,
              value: receipt,
            },
          ],
          count: (meta?.count ?? existing.length) + additions.length,
          result: {
            added: receipt.added,
            skipped: receipt.skipped,
            replayed: false,
          },
          action: "glossary.imported",
          details: { added: receipt.added, skipped: receipt.skipped },
        };
      },
    );
  }
  async export(identity: Identity, id: string) {
    const project = await this.project(identity, id);
    if (identity.mcp)
      throw new HttpError(403, "Use the scoped glossary MCP tool.");
    const { terms } = await this.state(id);
    await this.store.transact([
      mcpAudit("glossary.exported", actor(identity), id, {
        count: terms.length,
      }),
    ]);
    return {
      format: "keylo-glossary" as const,
      version: 1 as const,
      sourceLanguage: project.sourceLanguage,
      terms: [...terms]
        .sort((a, b) => (order(a) < order(b) ? -1 : 1))
        .map(({ source, translations, notes, caseSensitive }) => ({
          source,
          translations,
          notes,
          caseSensitive,
        })),
    };
  }
}
