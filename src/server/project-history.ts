import { canonicalJSON } from "../canonical-json";
import { randomUUID, createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { authorize, HttpError } from "./auth";
import { KeyloService, indexed, count, emptyStats } from "./service";
import { dataPrefix } from "./project-data";
import { Conflict, type Store, type Change } from "./store";
import type {
  Identity,
  Project,
  ProjectStats,
  TranslationKey,
} from "../shared";
import { projectSchema, keySchema } from "../validation";
import { mcpAudit } from "./mcp-credentials";
import { resolveProject, translationComplete } from "../messages";

import { compileMessage, compileRules } from "./ota-messages";

type Snapshot = {
  id: string;
  label: string;
  createdAt: string;
  createdBy: string;
  kind: "manual" | "automatic" | "safety" | "release";
  status: "building" | "ready" | "failed";
  project: Project;
  keys: number;
  parts: number;
  bytes: number;
  checksum: string;
  checksumVersion?: number;
  version: number;
};
export type Release = {
  id: string;
  label: string;
  createdAt: string;
  createdBy: string;
  languages: string[];
  snapshot: string;
  version: number;
};
const timestamp = () => new Date().toISOString();
const pk = (id: string) => `PROJECT#${id}`;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const keyInput = (key: TranslationKey) => ({
  name: key.name,
  namespace: key.namespace,
  description: key.description,
  tags: key.tags,
  translations: key.translations,
  ...(key.plural !== undefined ? { plural: key.plural } : {}),
});
export async function batches(store: Store, changes: Change[]) {
  const groups: Change[][] = [];
  let group: Change[] = [],
    size = 0;
  for (const change of changes) {
    const bytes = Buffer.byteLength(JSON.stringify(change));
    if (
      group.length &&
      (group.length >= 25 || size + bytes > 3 * 1024 * 1024)
    ) {
      groups.push(group);
      group = [];
      size = 0;
    }
    group.push(change);
    size += bytes;
  }
  if (group.length) groups.push(group);
  for (let i = 0; i < groups.length; i += 4) {
    const results = await Promise.allSettled(
      groups.slice(i, i + 4).map((group) => store.transact(group)),
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
}
function settings(project: Project) {
  return projectSchema.parse({
    id: project.id,
    name: project.name,
    description: project.description,
    sourceLanguage: project.sourceLanguage,
    languages: project.languages,
    color: project.color,
    ...(project.snapshotPolicy
      ? { snapshotPolicy: project.snapshotPolicy }
      : {}),
  });
}

export class ProjectHistory {
  private svc: KeyloService;
  constructor(private store: Store) {
    this.svc = new KeyloService(store);
  }
  async list(identity: Identity, id: string) {
    authorize(identity, id, "manager");
    await this.svc.project(identity, id);
    return (await this.store.list<Snapshot>(pk(id), "SNAP#"))
      .filter((snapshot) => snapshot.kind !== "release")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(({ project, ...snapshot }) => snapshot);
  }
  private async stamp(project: Project) {
    const stats = await this.store.get<ProjectStats>(
      pk(project.id),
      `${dataPrefix(project)}STATS`,
    );
    if (!stats) throw new Conflict();
    return stats;
  }
  async create(
    identity: Identity,
    id: string,
    label: string,
    kind: Snapshot["kind"] = "manual",
  ): Promise<Snapshot> {
    authorize(identity, id, "manager");
    label = z.string().trim().min(1).max(100).parse(label);
    const project = await this.svc.project(identity, id);
    const before = await this.stamp(project);
    const keys = (await this.svc.keys(identity, id)).map((key) => ({
      ...keyInput(key),
      version: key.version,
      createdAt: key.createdAt,
      updatedAt: key.updatedAt,
      updatedBy: key.updatedBy,
    }));
    const groups: (typeof keys)[] = [];
    let group: typeof keys = [],
      size = 0,
      total = 0;
    for (const key of keys) {
      keySchema.parse(keyInput(key));
      const bytes = Buffer.byteLength(JSON.stringify(key));
      total += bytes;
      if (total > 20 * 1024 * 1024)
        throw new HttpError(
          413,
          "Snapshots support up to 20 MB of project text. Split this project into smaller projects.",
        );
      if (group.length && size + bytes > 220000) {
        groups.push(group);
        group = [];
        size = 0;
      }
      group.push(key);
      size += bytes;
    }
    if (group.length) groups.push(group);
    const snapshot: Snapshot = {
      id: randomUUID(),
      label,
      createdAt: timestamp(),
      createdBy: identity.name,
      kind,
      status: "building",
      project,
      keys: keys.length,
      parts: groups.length,
      bytes: total,
      checksum: hash(canonicalJSON({ project: settings(project), keys })),
      checksumVersion: 2,
      version: 1,
    };
    await this.store.put(pk(id), `SNAP#${snapshot.id}`, snapshot);
    try {
      await batches(
        this.store,
        groups.map((keys, index) => ({
          pk: pk(id),
          sk: `SNAPDATA#${snapshot.id}#${String(index).padStart(5, "0")}`,
          value: { version: 1, index, keys },
        })),
      );
      snapshot.status = "ready";
      snapshot.version = 2;
      await this.store.transact([
        {
          pk: "WORKSPACE",
          sk: `PROJECT#${id}`,
          check: true,
          expectedVersion: project.version,
        },
        {
          pk: pk(id),
          sk: `${dataPrefix(project)}STATS`,
          check: true,
          expectedVersion: before.version,
        },
        {
          pk: pk(id),
          sk: `SNAP#${snapshot.id}`,
          value: snapshot,
          expectedVersion: 1,
        },
        mcpAudit("project.snapshot_created", identity.sub, id, {
          snapshot: snapshot.id,
          kind,
          keys: keys.length,
        }),
      ]);
      return snapshot;
    } catch (error) {
      await this.store
        .put(
          pk(id),
          `SNAP#${snapshot.id}`,
          { ...snapshot, status: "failed", version: 2 },
          1,
        )
        .catch(() => {});
      throw error;
    }
  }
  private async read(identity: Identity, id: string, snapshotId: string) {
    authorize(identity, id, "manager");
    await this.svc.project(identity, id);
    z.uuid().parse(snapshotId);
    const snapshot = await this.store.get<Snapshot>(
      pk(id),
      `SNAP#${snapshotId}`,
    );
    if (!snapshot || snapshot.status !== "ready")
      throw new HttpError(404, "Snapshot is not available.");
    if (snapshot.project.id !== id)
      throw new HttpError(409, "Snapshot project identity is invalid.");
    settings(snapshot.project);
    const parts = await this.store.list<{
      version: number;
      index: number;
      keys: TranslationKey[];
    }>(pk(id), `SNAPDATA#${snapshotId}#`);
    if (
      parts.length !== snapshot.parts ||
      parts.some((part, index) => part.index !== index)
    )
      throw new HttpError(
        409,
        "Snapshot is incomplete. Restore was not started.",
      );
    const keys = parts.flatMap((part) => part.keys);
    if (
      keys.length !== snapshot.keys ||
      new Set(keys.map((key) => key.name)).size !== keys.length ||
      hash(
        canonicalJSON(
          snapshot.checksumVersion === 2
            ? { project: settings(snapshot.project), keys }
            : keys,
        ),
      ) !== snapshot.checksum
    )
      throw new HttpError(409, "Snapshot failed its integrity validation.");
    for (const key of keys) keySchema.parse(keyInput(key));
    return { snapshot, keys };
  }
  async download(identity: Identity, id: string, snapshotId: string) {
    const { snapshot, keys } = await this.read(identity, id, snapshotId);
    return {
      schema: 1,
      project: settings(snapshot.project),
      createdAt: snapshot.createdAt,
      keys: keys.map(keyInput),
    };
  }
  async manifest(identity: Identity, id: string, snapshotId: string) {
    authorize(identity, id, "manager");
    await this.svc.project(identity, id);
    z.uuid().parse(snapshotId);
    const snapshot = await this.store.get<Snapshot>(
      pk(id),
      `SNAP#${snapshotId}`,
    );
    if (!snapshot || snapshot.status !== "ready")
      throw new HttpError(404, "Snapshot is not available.");
    return {
      schema: 1,
      project: settings(snapshot.project),
      createdAt: snapshot.createdAt,
      parts: snapshot.parts,
      keys: snapshot.keys,
      checksum: snapshot.checksum,
      checksumVersion: snapshot.checksumVersion ?? 1,
    };
  }
  async part(
    identity: Identity,
    id: string,
    snapshotId: string,
    index: number,
  ) {
    const manifest = await this.manifest(identity, id, snapshotId);
    if (!Number.isInteger(index) || index < 0 || index >= manifest.parts)
      throw new HttpError(400, "Invalid snapshot part.");
    const part = await this.store.get<{ keys: TranslationKey[] }>(
      pk(id),
      `SNAPDATA#${snapshotId}#${String(index).padStart(5, "0")}`,
    );
    if (!part) throw new HttpError(409, "Snapshot part is missing.");
    return part;
  }
  async restore(
    identity: Identity,
    id: string,
    snapshotId: string,
    expectedVersion: number,
  ) {
    authorize(identity, id, "manager");
    const { snapshot, keys } = await this.read(identity, id, snapshotId);
    const current = await this.svc.project(identity, id);
    if (current.version !== expectedVersion) throw new Conflict();
    const before = await this.stamp(current);
    const safety = await this.create(
      identity,
      id,
      `Before restore · ${snapshot.label}`.slice(0, 100),
      "safety",
    );
    const revision = randomUUID();
    const restored: Project = {
      ...current,
      ...settings(snapshot.project),
      snapshotPolicy: current.snapshotPolicy,
      dataRevision: revision,
      version: current.version + 1,
      updatedAt: timestamp(),
    };
    const stats = emptyStats();
    const liveKeys = await this.svc.keys(identity, id);
    const version =
      [...keys, ...liveKeys].reduce(
        (max, key) => Math.max(max, key.version),
        Date.now(),
      ) + 1;
    const staged = keys.map((key) => indexed({ ...key, version }));
    resolveProject(staged, restored, true);
    for (const key of staged) count(stats, key, 1);
    await this.store.put(pk(id), `CLEANUP#${revision}`, {
      id: revision,
      version: 1,
      prefix: dataPrefix(restored),
      createdAt: timestamp(),
    });
    await batches(
      this.store,
      staged.map((key) => ({
        pk: pk(id),
        sk: `${dataPrefix(restored)}KEY#${key.name}`,
        value: key,
      })),
    );
    await this.store.transact([
      {
        pk: pk(id),
        sk: `${dataPrefix(current)}STATS`,
        check: true,
        expectedVersion: before.version,
      },
      { pk: pk(id), sk: `${dataPrefix(restored)}STATS`, value: stats },
      {
        pk: "WORKSPACE",
        sk: `PROJECT#${id}`,
        value: restored,
        expectedVersion: current.version,
      },
      { pk: pk(id), sk: `CLEANUP#${revision}`, expectedVersion: 1 },
      {
        pk: pk(id),
        sk: `CLEANUP#${current.dataRevision ?? "legacy"}`,
        value: {
          id: current.dataRevision ?? "legacy",
          version: 1,
          prefix: dataPrefix(current),
          createdAt: timestamp(),
        },
      },
      mcpAudit("project.snapshot_restored", identity.sub, id, {
        snapshot: snapshotId,
        safety: safety.id,
      }),
    ]);
    return { project: restored, safetySnapshot: safety.id };
  }
  async releases(identity: Identity, id: string) {
    authorize(identity, id, "manager");
    await this.svc.project(identity, id);
    const releases = await this.store.list<Release>(pk(id), "OTARELEASE#");
    const heads = await this.store.list<{
      version: number;
      release: string;
      channel: string;
    }>(pk(id), "OTAHEAD#");
    const tokens = await this.store.list<{
      version: number;
      hash: string;
      name: string;
      createdAt: string;
    }>(pk(id), "OTAKEY#");
    return {
      releases: releases.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      heads,
      tokens: tokens.map(({ hash, ...token }) => ({ ...token, id: hash })),
    };
  }
  async publish(identity: Identity, id: string, input: unknown) {
    authorize(identity, id, "manager");
    const data = z
      .object({
        label: z.string().trim().min(1).max(100),
        channel: z.enum(["production", "preview"]),
        expectedHeadVersion: z.number().int().nonnegative(),
      })
      .strict()
      .parse(input);
    const snapshot = await this.create(identity, id, data.label, "release");
    const captured = await this.read(identity, id, snapshot.id);
    const project = captured.snapshot.project;
    const keys = resolveProject(captured.keys, captured.snapshot.project);
    const release: Release = {
      id: randomUUID(),
      label: data.label,
      createdAt: timestamp(),
      createdBy: identity.name,
      languages: project.languages.map((locale) => locale.code),
      snapshot: snapshot.id,
      version: 1,
    };
    const writes: Change[] = [];
    for (const locale of project.languages) {
      const messages: Record<string, unknown> = {};
      for (const key of keys) {
        if (!translationComplete(key, locale))
          throw new HttpError(
            422,
            `Complete ${key.name} (${locale.code}) before publishing. Drafts were not published.`,
          );
        const value = (key.resolvedTranslations ?? key.translations)[
          locale.code
        ]!;
        try {
          messages[key.name] = { value, nodes: compileMessage(value) };
        } catch (error) {
          throw new HttpError(
            422,
            `${key.name} (${locale.code}): ${(error as Error).message}`,
          );
        }
      }
      const body = JSON.stringify({
        schema: 1,
        project: id,
        release: release.id,
        locale: locale.code,
        sourceLanguage: project.sourceLanguage,
        rules: {
          cardinal: compileRules(locale.code, "cardinal"),
          ordinal: compileRules(locale.code, "ordinal"),
        },
        messages,
      });
      if (Buffer.byteLength(body) > 2 * 1024 * 1024)
        throw new HttpError(413, "OTA supports language bundles up to 2 MB.");
      const chunks: string[] = [];
      // Split by UTF-16 code units; JSON transport reassembles before parsing.
      for (let i = 0; i < body.length; i += 40000)
        chunks.push(body.slice(i, i + 40000));
      for (const [index, text] of chunks.entries())
        writes.push({
          pk: pk(id),
          sk: `OTADATA#${release.id}#${locale.code}#${String(index).padStart(5, "0")}`,
          value: { version: 1, text },
        });
      writes.push({
        pk: pk(id),
        sk: `OTABUNDLE#${release.id}#${locale.code}`,
        value: {
          version: 1,
          etag: hash(body),
          parts: chunks.length,
          bytes: Buffer.byteLength(body),
        },
      });
    }
    await this.store.put(pk(id), `OTABUILD#${release.id}`, {
      version: 1,
      id: release.id,
      createdAt: timestamp(),
      keys: writes.map((write) => write.sk),
    });
    await batches(this.store, writes);
    await this.store.transact([
      { pk: pk(id), sk: `OTARELEASE#${release.id}`, value: release },
      { pk: pk(id), sk: `OTABUILD#${release.id}`, expectedVersion: 1 },
      {
        pk: pk(id),
        sk: `OTAHEAD#${data.channel}`,
        value: {
          version: data.expectedHeadVersion + 1,
          channel: data.channel,
          release: release.id,
        },
        ...(data.expectedHeadVersion
          ? { expectedVersion: data.expectedHeadVersion }
          : {}),
      },
      mcpAudit("ota.release_published", identity.sub, id, {
        release: release.id,
        channel: data.channel,
      }),
    ]);
    return release;
  }
  async pointRelease(identity: Identity, id: string, input: unknown) {
    authorize(identity, id, "manager");
    await this.svc.project(identity, id);
    const data = z
      .object({
        release: z.uuid(),
        channel: z.enum(["production", "preview"]),
        expectedHeadVersion: z.number().int().nonnegative(),
      })
      .strict()
      .parse(input);
    if (!(await this.store.get<Release>(pk(id), `OTARELEASE#${data.release}`)))
      throw new HttpError(404, "Published release not found.");
    await this.store.transact([
      {
        pk: pk(id),
        sk: `OTAHEAD#${data.channel}`,
        value: {
          version: data.expectedHeadVersion + 1,
          channel: data.channel,
          release: data.release,
        },
        ...(data.expectedHeadVersion
          ? { expectedVersion: data.expectedHeadVersion }
          : {}),
      },
      mcpAudit("ota.channel_changed", identity.sub, id, {
        release: data.release,
        channel: data.channel,
      }),
    ]);
    return { release: data.release };
  }
  async createDeliveryKey(identity: Identity, id: string, name: string) {
    authorize(identity, id, "manager");
    await this.svc.project(identity, id);
    name = z.string().trim().min(1).max(80).parse(name);
    const secret = `klo_${id}.${randomBytes(32).toString("base64url")}`;
    const digest = hash(secret);
    await this.store.transact([
      {
        pk: pk(id),
        sk: `OTAKEY#${digest}`,
        value: {
          version: 1,
          hash: digest,
          name,
          createdAt: timestamp(),
          createdBy: identity.sub,
        },
      },
      mcpAudit("ota.delivery_key_created", identity.sub, id, {
        credential: digest,
      }),
    ]);
    return { secret, id: digest, name };
  }
  async revokeDeliveryKey(identity: Identity, id: string, digest: string) {
    authorize(identity, id, "manager");
    await this.svc.project(identity, id);
    if (!/^[a-f0-9]{64}$/.test(digest))
      throw new HttpError(400, "Invalid credential ID.");
    await this.store.transact([
      { pk: pk(id), sk: `OTAKEY#${digest}`, expectedVersion: 1 },
      mcpAudit("ota.delivery_key_revoked", identity.sub, id, {
        credential: digest,
      }),
    ]);
  }
  async deliver(
    id: string,
    locale: string,
    channel: string,
    token: string,
    etag: string | null,
  ) {
    if (
      !/^[a-z0-9][a-z0-9-]{0,47}$/.test(id) ||
      !["production", "preview"].includes(channel) ||
      Intl.getCanonicalLocales(locale)[0] !== locale
    )
      throw new HttpError(400, "Invalid delivery request.");
    if (!token || !(await this.store.get(pk(id), `OTAKEY#${hash(token)}`)))
      throw new HttpError(401, "A valid delivery key is required.");
    const head = await this.store.get<{ release: string }>(
      pk(id),
      `OTAHEAD#${channel}`,
    );
    if (!head)
      throw new HttpError(404, "This channel has no published release.");
    const bundle = await this.store.get<{
      etag: string;
      parts: number;
      bytes: number;
    }>(pk(id), `OTABUNDLE#${head.release}#${locale}`);
    if (!bundle) throw new HttpError(404, "This language is not published.");
    const headers = {
      "Content-Type": "application/json; charset=utf-8",
      ETag: `"${bundle.etag}"`,
      "Cache-Control": "private, no-cache",
      Vary: "Authorization",
    };
    if (etag === headers.ETag)
      return new Response(null, { status: 304, headers });
    const parts = await this.store.list<{ text: string }>(
      pk(id),
      `OTADATA#${head.release}#${locale}#`,
    );
    const body = parts.map((part) => part.text).join("");
    if (
      parts.length !== bundle.parts ||
      Buffer.byteLength(body) !== bundle.bytes ||
      hash(body) !== bundle.etag
    )
      throw new HttpError(
        503,
        "The published bundle is incomplete. Keep your cached translations.",
      );
    return new Response(body, { headers });
  }
  async maintenance(identity: Identity) {
    if (!identity.admin) throw new HttpError(403, "Admin required.");
    const projects = (await this.svc.bootstrap(identity)).projects.sort(
      (a, b) => a.id.localeCompare(b.id),
    );
    const cursor = await this.store.get<{ version: number; last: string }>(
      "WORKSPACE",
      "SNAPSHOT_JOB_CURSOR",
    );
    const split = cursor
      ? projects.findIndex((project) => project.id > cursor.last)
      : 0;
    const ordered =
      split > 0
        ? [...projects.slice(split), ...projects.slice(0, split)]
        : projects;
    let cursorVersion = cursor?.version;
    const deadline = Date.now() + 20000;
    const outcomes: { project: string; status: string }[] = [];
    for (const project of ordered) {
      if (Date.now() > deadline) break;
      // Advance before work: a consistently failing large project cannot starve others.
      await this.store.put(
        "WORKSPACE",
        "SNAPSHOT_JOB_CURSOR",
        { version: (cursorVersion ?? 0) + 1, last: project.id },
        cursorVersion,
      );
      cursorVersion = (cursorVersion ?? 0) + 1;
      try {
        const snapshots = await this.store.list<Snapshot>(
          pk(project.id),
          "SNAP#",
        );
        const automatic = snapshots
          .filter(
            (snapshot) =>
              snapshot.kind === "automatic" && snapshot.status === "ready",
          )
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        const policy = project.snapshotPolicy;
        if (
          policy?.enabled &&
          (!automatic[0] ||
            Date.now() - Date.parse(automatic[0].createdAt) >=
              policy.intervalHours * 3600000)
        ) {
          try {
            await this.create(
              identity,
              project.id,
              "Automatic snapshot",
              "automatic",
            );
            outcomes.push({ project: project.id, status: "created" });
          } catch {
            outcomes.push({ project: project.id, status: "failed" });
          }
        }
        const releases = await this.store.list<Release>(
          pk(project.id),
          "OTARELEASE#",
        );
        const releaseSnapshots = new Set(
          releases.map((release) => release.snapshot),
        );
        const expired = automatic
          .slice(policy?.retention ?? 7)
          .concat(
            snapshots.filter(
              (snapshot) =>
                (snapshot.status !== "ready" ||
                  (snapshot.kind === "release" &&
                    !releaseSnapshots.has(snapshot.id))) &&
                Date.now() - Date.parse(snapshot.createdAt) > 86400000,
            ),
          );
        for (const snapshot of expired) {
          const parts = await this.store.list<{
            version: number;
            index: number;
          }>(pk(project.id), `SNAPDATA#${snapshot.id}#`);
          await batches(
            this.store,
            parts.map((part) => ({
              pk: pk(project.id),
              sk: `SNAPDATA#${snapshot.id}#${String(part.index).padStart(5, "0")}`,
              expectedVersion: part.version,
            })),
          );
          await this.store.remove(
            pk(project.id),
            `SNAP#${snapshot.id}`,
            snapshot.version,
          );
        }
        const builds = await this.store.list<{
          id: string;
          version: number;
          keys: string[];
          createdAt: string;
        }>(pk(project.id), "OTABUILD#");
        for (const build of builds) {
          if (Date.now() - Date.parse(build.createdAt) < 86400000) continue;
          if (releases.some((release) => release.id === build.id)) continue;
          const abandoned: Change[] = [];
          for (const sk of build.keys)
            if (await this.store.get(pk(project.id), sk))
              abandoned.push({ pk: pk(project.id), sk, expectedVersion: 1 });
          await batches(this.store, abandoned);
          await this.store.remove(
            pk(project.id),
            `OTABUILD#${build.id}`,
            build.version,
          );
        }
        const cleanups = await this.store.list<{
          id: string;
          version: number;
          prefix: string;
          createdAt: string;
        }>(pk(project.id), "CLEANUP#");
        for (const cleanup of cleanups) {
          if (Date.now() - Date.parse(cleanup.createdAt) < 3600000) continue;
          if (
            cleanup.prefix ===
            dataPrefix(await this.svc.project(identity, project.id))
          )
            continue;
          const keys = await this.store.list<TranslationKey>(
            pk(project.id),
            `${cleanup.prefix}KEY#`,
          );
          await batches(
            this.store,
            keys.map((key) => ({
              pk: pk(project.id),
              sk: `${cleanup.prefix}KEY#${key.name}`,
              expectedVersion: key.version,
            })),
          );
          const stats = await this.store.get<ProjectStats>(
            pk(project.id),
            `${cleanup.prefix}STATS`,
          );
          if (stats)
            await this.store.remove(
              pk(project.id),
              `${cleanup.prefix}STATS`,
              stats.version,
            );
          await this.store.remove(
            pk(project.id),
            `CLEANUP#${cleanup.id}`,
            cleanup.version,
          );
        }
      } catch {
        outcomes.push({ project: project.id, status: "failed" });
      }
    }
    return outcomes;
  }
}
