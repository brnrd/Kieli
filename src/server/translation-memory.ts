import { createHash } from "node:crypto";
import { z } from "zod";
import type { Identity, Project, TranslationKey } from "../shared";
import type { MemoryPage, MemorySuggestion } from "../translation-memory";
import { completeMessage, references, validatePlural } from "../messages";
import { authorize } from "./auth";
import { HttpError } from "./errors";
import { Conflict, type Store, type Change } from "./store";
import { dataPrefix } from "./project-data";
import { freshnessView } from "./freshness";
import { validatePlaceholders } from "./placeholder-validation";
import { legacyKeyId, type KeyEdit } from "./key-history";

type Pointer = {
  version: number;
  eventId: string;
  keyId: string;
  keyName: string;
  side: "before" | "after";
};
type IndexState = {
  version: number;
  done: boolean;
  scanned: number;
  cursor?: string;
};
export const memoryHash = (
  sourceLanguage: string,
  source: string,
  plural: boolean,
) =>
  createHash("sha256")
    .update(JSON.stringify([sourceLanguage, source, plural]))
    .digest("hex");
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const pointerPrefix = (language: string, source: string, plural: boolean) =>
  `TM#${memoryHash(language, source, plural)}#`;
const metaKey = (project: Project) => `TM_INDEX#${project.sourceLanguage}`;

// Compact immutable pointers, never another copy of the translation. Include both
// sides so the first edit after upgrade also makes the prior wording reusable.
export function memoryChanges(project: Project, event: KeyEdit): Change[] {
  if (event.sourceLanguage && event.sourceLanguage !== project.sourceLanguage)
    return [];
  return (["before", "after"] as const).flatMap((side) => {
    const state = event[side],
      source = state?.translations[project.sourceLanguage];
    if (!state || !source?.trim() || references(source).length) return [];
    return [
      {
        pk: `PROJECT#${project.id}`,
        sk: `${pointerPrefix(project.sourceLanguage, source, !!state.plural)}${event.at}#${event.id}#${side === "after" ? "1" : "0"}`,
        value: {
          version: 1,
          eventId: event.id,
          keyId: event.keyId,
          keyName: state.name,
          side,
        },
      },
    ];
  });
}
export class TranslationMemory {
  constructor(private store: Store) {}
  private async project(identity: Identity, id: string, write = false) {
    if (identity.tokenProject || identity.mcp || identity.sync)
      throw new HttpError(403, "Sign in to use previous translations.");
    authorize(identity, id, write ? "manager" : "user");
    const project = await this.store.get<Project>("WORKSPACE", `PROJECT#${id}`);
    if (!project) throw new HttpError(404, "Project not found.");
    return project;
  }
  private async status(project: Project) {
    const state = await this.store.get<IndexState>(
      `PROJECT#${project.id}`,
      metaKey(project),
    );
    return { done: state?.done ?? false, scanned: state?.scanned ?? 0 };
  }
  async lookup(
    identity: Identity,
    id: string,
    input: unknown,
  ): Promise<MemoryPage> {
    const project = await this.project(identity, id);
    const data = z
      .object({
        source: z.string().min(1).max(20000),
        plural: z.boolean().default(false),
        language: z.string().min(2).max(35),
        cursor: z.string().max(2048).optional(),
      })
      .strict()
      .parse(input);
    const locale = project.languages.find(
      (locale) => locale.code === data.language,
    );
    if (!locale || locale.code === project.sourceLanguage)
      throw new HttpError(400, "Choose a configured target language.");
    const sourceHash = memoryHash(
      project.sourceLanguage,
      data.source,
      data.plural,
    );
    const prefix = `TM#${sourceHash}#`;
    let cursor: string | undefined;
    if (data.cursor) {
      try {
        const decoded = JSON.parse(
          Buffer.from(data.cursor, "base64url").toString(),
        );
        if (
          decoded.project !== id ||
          decoded.hash !== sourceHash ||
          decoded.language !== data.language ||
          typeof decoded.cursor !== "string"
        )
          throw new Error();
        const inner = JSON.parse(
          Buffer.from(decoded.cursor, "base64url").toString(),
        );
        if (
          inner.pk !== `PROJECT#${id}` ||
          typeof inner.sk !== "string" ||
          !inner.sk.startsWith(prefix)
        )
          throw new Error();
        cursor = decoded.cursor;
      } catch {
        throw new HttpError(400, "Invalid previous-translation cursor.");
      }
    }
    const page = await this.store.page<Pointer>(`PROJECT#${id}`, prefix, {
      limit: 20,
      cursor,
      reverse: true,
    });
    const items: MemorySuggestion[] = [];
    const seen = new Set<string>();
    const candidates = await Promise.all(
      page.items.map(async (pointer) => {
        const [event, current] = await Promise.all([
          this.store.get<KeyEdit>(
            `PROJECT#${id}`,
            `KEY_HISTORY#${pointer.keyId}#${pointer.eventId}`,
          ),
          this.store.get<TranslationKey>(
            `PROJECT#${id}`,
            `${dataPrefix(project)}KEY#${pointer.keyName}`,
          ),
        ]);
        return { pointer, event, current };
      }),
    );
    // History pointers retain their original names. Resolve a renamed identity
    // within the active dataset; never follow a reused name to a different key.
    if (
      candidates.some(
        ({ pointer, current }) =>
          !current ||
          (current.id ?? legacyKeyId(id, current.name)) !== pointer.keyId,
      )
    ) {
      const active = new Map(
        (
          await this.store.list<TranslationKey>(
            `PROJECT#${id}`,
            `${dataPrefix(project)}KEY#`,
          )
        ).map((key) => [key.id ?? legacyKeyId(id, key.name), key]),
      );
      for (const candidate of candidates)
        candidate.current = active.get(candidate.pointer.keyId);
    }
    for (const { pointer, event, current } of candidates) {
      // Deleted keys, obsolete datasets and a reused key name must not expose copy.
      if (
        !current ||
        (current.id ?? legacyKeyId(id, current.name)) !== pointer.keyId ||
        !event ||
        event.keyId !== pointer.keyId ||
        (event.sourceLanguage &&
          event.sourceLanguage !== project.sourceLanguage)
      )
        continue;
      const state = event[pointer.side];
      const target = state?.translations[data.language];
      if (
        !state ||
        state.name !== pointer.keyName ||
        state.translations[project.sourceLanguage] !== data.source ||
        !!state.plural !== data.plural ||
        !target?.trim() ||
        references(target).length ||
        seen.has(target)
      )
        continue;
      const historical = freshnessView([state as TranslationKey], project)[0]!;
      if (
        historical.outdatedLanguages?.includes(data.language) ||
        !completeMessage(target, locale, data.plural)
      )
        continue;
      try {
        if (data.plural) {
          validatePlural(data.source);
          validatePlural(target);
        }
        validatePlaceholders(data.source, target);
      } catch {
        continue;
      }
      seen.add(target);
      items.push({
        id: hash(
          JSON.stringify([
            pointer.keyId,
            pointer.eventId,
            pointer.side,
            data.language,
          ]),
        ),
        text: target,
        keyName: pointer.keyName,
        keyVersion: state.version,
        savedAt: state.updatedAt,
        savedBy: state.updatedBy,
        recordedAt: event.at,
        origin: event.origin,
        side: pointer.side,
      });
    }
    const latest = await this.project(identity, id);
    if (latest.version !== project.version) throw new Conflict();
    return {
      items,
      index: await this.status(project),
      ...(page.nextCursor
        ? {
            nextCursor: Buffer.from(
              JSON.stringify({
                project: id,
                hash: sourceHash,
                language: data.language,
                cursor: page.nextCursor,
              }),
            ).toString("base64url"),
          }
        : {}),
    };
  }
  async indexBatch(identity: Identity, id: string, input: unknown = {}) {
    const project = await this.project(identity, id, true),
      pk = `PROJECT#${id}`;
    z.object({}).strict().parse(input);
    const state = await this.store.get<IndexState>(pk, metaKey(project));
    if (state?.done) return { done: true, scanned: state.scanned };
    const page = await this.store.page<KeyEdit>(pk, "KEY_HISTORY#", {
      limit: 30,
      cursor: state?.cursor,
    });
    const pointers = page.items.flatMap((event) =>
      memoryChanges(project, event),
    );
    const existing = await Promise.all(
      pointers.map((pointer) => this.store.get(pointer.pk, pointer.sk)),
    );
    const next = {
      version: (state?.version ?? 0) + 1,
      scanned: (state?.scanned ?? 0) + page.items.length,
      done: !page.nextCursor,
      ...(page.nextCursor ? { cursor: page.nextCursor } : {}),
    };
    await this.store.transact([
      {
        pk: "WORKSPACE",
        sk: `PROJECT#${id}`,
        check: true,
        expectedVersion: project.version,
      },
      ...pointers.filter((_, index) => !existing[index]),
      {
        pk,
        sk: metaKey(project),
        expectedVersion: state?.version,
        value: next,
      },
    ]);
    return { done: next.done, scanned: next.scanned };
  }
}
