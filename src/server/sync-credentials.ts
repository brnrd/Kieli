import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { Identity, Project } from "../shared";
import { authorize, hashToken } from "./auth";
import { HttpError } from "./errors";
import { Conflict, type Store, type Change } from "./store";
import { LocalAuth } from "./local-auth";
import { mcpAudit } from "./mcp-credentials";
type Credential = {
  version: number;
  id: string;
  projectId: string;
  name: string;
  prefix: string;
  prefixes: string[];
  createdBy: string;
  createdByName: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt?: string;
  ttl: number;
};
const invalid = () =>
  new HttpError(401, "Source-sync credential expired, revoked or invalid.");
const view = ({ version, projectId, createdBy, ttl, ...safe }: Credential) =>
  safe;
export class SyncCredentials {
  constructor(readonly store: Store) {}
  async list(identity: Identity, id: string) {
    authorize(identity, id, "manager");
    return (
      await this.store.list<Credential>(`PROJECT#${id}`, "SYNC_TOKEN#")
    ).map(view);
  }
  async create(identity: Identity, id: string, input: unknown) {
    authorize(identity, id, "manager");
    if (identity.mcp || identity.tokenProject || identity.sync)
      throw new HttpError(403, "Sign in to manage source-sync credentials.");
    const data = z
      .object({
        name: z.string().trim().min(1).max(80),
        prefixes: z
          .array(
            z
              .string()
              .min(1)
              .max(180)
              .regex(/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/),
          )
          .max(20)
          .default([]),
        expiresInDays: z.number().int().min(1).max(365).default(90),
      })
      .strict()
      .parse(input);
    if (!(await this.store.get<Project>("WORKSPACE", `PROJECT#${id}`)))
      throw new HttpError(404, "Project not found.");
    const secret = `kieli_sync_${id}.${randomBytes(32).toString("hex")}`,
      credential: Credential = {
        version: 1,
        id: hashToken(secret),
        projectId: id,
        name: data.name,
        prefixes: [...new Set(data.prefixes)],
        prefix: secret.slice(0, secret.indexOf(".") + 9),
        createdBy: identity.sub,
        createdByName: identity.name,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(
          Date.now() + data.expiresInDays * 86400000,
        ).toISOString(),
        ttl: Math.ceil(Date.now() / 1000) + data.expiresInDays * 86400,
      };
    await this.store.transact([
      {
        pk: `PROJECT#${id}`,
        sk: `SYNC_TOKEN#${credential.id}`,
        value: credential,
      },
      mcpAudit("sync.credential_created", identity.sub, id, {
        credential: credential.id,
        prefixes: credential.prefixes,
      }),
    ]);
    return { secret, credential: view(credential) };
  }
  async revoke(identity: Identity, id: string, token: string) {
    authorize(identity, id, "manager");
    z.string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(token);
    for (let i = 0; i < 8; i++) {
      const row = await this.store.get<Credential>(
        `PROJECT#${id}`,
        `SYNC_TOKEN#${token}`,
      );
      if (!row) return;
      try {
        await this.store.transact([
          {
            pk: `PROJECT#${id}`,
            sk: `SYNC_TOKEN#${token}`,
            expectedVersion: row.version,
          },
          mcpAudit("sync.credential_revoked", identity.sub, id, {
            credential: token,
          }),
        ]);
        return;
      } catch (error) {
        if (!(error instanceof Conflict) || i === 7) throw error;
      }
    }
  }
  async authenticate(request: Request) {
    const match =
      /^Bearer (kieli_sync_([a-z0-9][a-z0-9-]{0,47})\.[a-f0-9]{64})$/.exec(
        request.headers.get("authorization") ?? "",
      );
    if (!match) throw invalid();
    const projectId = match[2]!,
      id = hashToken(match[1]!),
      pk = `PROJECT#${projectId}`,
      sk = `SYNC_TOKEN#${id}`,
      row = await this.store.get<Credential>(pk, sk);
    if (!row || Date.parse(row.expiresAt) <= Date.now()) throw invalid();
    await new LocalAuth(this.store).limit(`sync:${id}`, 240, 60);
    if (!row.lastUsedAt || Date.now() - Date.parse(row.lastUsedAt) >= 60000)
      try {
        await this.store.put(
          pk,
          sk,
          {
            ...row,
            version: row.version + 1,
            lastUsedAt: new Date().toISOString(),
          },
          row.version,
        );
      } catch (error) {
        if (!(error instanceof Conflict)) throw error;
        if (!(await this.store.get(pk, sk))) throw invalid();
      }
    return {
      sub: `service:${id}`,
      name: `CI · ${row.name}`,
      email: "",
      admin: false,
      projects: { [projectId]: "manager" },
      sync: { projectId, credentialId: id, prefixes: row.prefixes },
    } satisfies Identity;
  }
  async writeGuards(identity: Identity): Promise<Change[]> {
    const grant = identity.sync;
    if (!grant || identity.sub !== `service:${grant.credentialId}`)
      throw invalid();
    const pk = `PROJECT#${grant.projectId}`,
      sk = `SYNC_TOKEN#${grant.credentialId}`,
      row = await this.store.get<Credential>(pk, sk);
    if (
      !row ||
      Date.parse(row.expiresAt) <= Date.now() ||
      JSON.stringify(row.prefixes) !== JSON.stringify(grant.prefixes)
    )
      throw invalid();
    return [{ pk, sk, check: true, expectedVersion: row.version }];
  }
}
