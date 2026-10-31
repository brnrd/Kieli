import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { AuthMode, Identity, McpTokenView, Project } from "../shared";
import { authorize, hashToken } from "./auth";
import { config } from "./config";
import { HttpError } from "./errors";
import { SsoDirectory } from "./sso-directory";
import { LocalAuth, userIdentity } from "./local-auth";
import { Conflict, getStore, type Change, type Store } from "./store";

type Credential = McpTokenView & {
  version: number;
  projectId: string;
  createdBy: string;
  authMode: AuthMode;
  ownerAuthVersion?: number;
  ownerPrincipalId?: string;
  ttl: number;
};
export function mcpAudit(
  action: string,
  actor: string,
  project: string,
  details: Record<string, unknown> = {},
): Change {
  const at = new Date().toISOString();
  return {
    pk: "AUTH_AUDIT",
    sk: `${at}#${randomUUID()}`,
    value: {
      version: 1,
      action,
      actor,
      project,
      at,
      outcome: "success",
      ...details,
    },
  };
}
const view = ({
  version,
  projectId,
  createdBy,
  authMode,
  ownerAuthVersion,
  ownerPrincipalId,
  ttl,
  ...safe
}: Credential): McpTokenView => safe;
const invalid = () =>
  new HttpError(
    401,
    "MCP credential expired, revoked, or no longer authorized.",
  );

export class McpCredentials {
  constructor(private store: Store) {}
  async list(identity: Identity, projectId: string) {
    authorize(identity, projectId, "manager");
    return (
      await this.store.list<Credential>(`PROJECT#${projectId}`, "MCP_TOKEN#")
    ).map(view);
  }
  async create(identity: Identity, projectId: string, input: unknown) {
    authorize(identity, projectId, "manager");
    if (identity.mcp || identity.tokenProject)
      throw new HttpError(403, "Sign in to manage connections.");
    const data = z
      .object({
        name: z.string().trim().min(1).max(80),
        languages: z.array(z.string().min(2).max(35)).min(1).max(29),
        expiresInDays: z.number().int().min(1).max(30).default(7),
        allowOverwrite: z.boolean().default(false),
      })
      .strict()
      .parse(input);
    const project = await this.store.get<Project>(
      "WORKSPACE",
      `PROJECT#${projectId}`,
    );
    if (!project) throw new HttpError(404, "Project not found.");
    if (
      new Set(data.languages).size !== data.languages.length ||
      data.languages.some(
        (code) =>
          code === project.sourceLanguage ||
          !project.languages.some((l) => l.code === code),
      )
    )
      throw new HttpError(
        400,
        "Select unique target languages enabled for this project.",
      );
    const mode = config().authMode;
    let ownerAuthVersion: number | undefined;
    let ownerPrincipalId: string | undefined;
    let guards: Change[] = [];
    let expiry = Date.now() + data.expiresInDays * 86400000;
    if (mode === "local") {
      const user = identity.sub.startsWith("local:")
        ? await new LocalAuth(this.store).getUser(identity.sub.slice(6))
        : undefined;
      if (!user || user.status !== "active") throw invalid();
      authorize(userIdentity(user, 0), projectId, "manager");
      ownerAuthVersion = user.authVersion;
      guards = [
        {
          pk: "USERS",
          sk: `USER#${user.id}`,
          check: true,
          expectedVersion: user.version,
        },
      ];
    } else if (mode !== "demo") {
      // Keep the absolute sign-in expiry in addition to current directory checks.
      const until =
        Math.min(
          identity.sessionExpiresAt ?? 0,
          (identity.authTime ?? 0) + 3600,
        ) * 1000;
      if (identity.provider !== mode || until <= Date.now()) throw invalid();
      expiry = Math.min(expiry, until);
      if (!identity.principalId || identity.accessVersion === undefined)
        throw invalid();
      guards = await new SsoDirectory(this.store).guards(
        identity.principalId,
        identity.accessVersion,
        projectId,
      );
      ownerPrincipalId = identity.principalId;
      ownerAuthVersion = identity.accessVersion;
    }
    const secret = `keylo_mcp_${projectId}.${randomBytes(32).toString("hex")}`;
    const id = hashToken(secret);
    const credential: Credential = {
      version: 1,
      id,
      projectId,
      name: data.name,
      languages: data.languages,
      allowOverwrite: data.allowOverwrite,
      prefix: secret.slice(0, secret.indexOf(".") + 9),
      createdBy: identity.sub,
      createdByName: identity.name,
      authMode: mode,
      ...(ownerAuthVersion === undefined ? {} : { ownerAuthVersion }),
      ...(ownerPrincipalId ? { ownerPrincipalId } : {}),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(expiry).toISOString(),
      ttl: Math.ceil(expiry / 1000),
    };
    await this.store.transact([
      ...guards,
      { pk: `PROJECT#${projectId}`, sk: `MCP_TOKEN#${id}`, value: credential },
      mcpAudit("mcp.credential_created", identity.sub, projectId, {
        credential: id,
        languages: data.languages,
        allowOverwrite: data.allowOverwrite,
      }),
    ]);
    return { secret, credential: view(credential) };
  }
  async revoke(identity: Identity, projectId: string, id: string) {
    authorize(identity, projectId, "manager");
    if (!/^[a-f0-9]{64}$/.test(id))
      throw new HttpError(400, "Invalid credential ID.");
    for (let attempt = 0; attempt < 8; attempt++) {
      const credential = await this.store.get<Credential>(
        `PROJECT#${projectId}`,
        `MCP_TOKEN#${id}`,
      );
      if (!credential) return;
      try {
        await this.store.transact([
          {
            pk: `PROJECT#${projectId}`,
            sk: `MCP_TOKEN#${id}`,
            expectedVersion: credential.version,
          },
          mcpAudit("mcp.credential_revoked", identity.sub, projectId, {
            credential: id,
          }),
        ]);
        return;
      } catch (error) {
        if (!(error instanceof Conflict) || attempt === 7) throw error;
      }
    }
  }
  async writeGuards(identity: Identity, projectId: string): Promise<Change[]> {
    const grant = identity.mcp;
    if (!grant || grant.projectId !== projectId) throw invalid();
    const credential = await this.store.get<Credential>(
      `PROJECT#${projectId}`,
      `MCP_TOKEN#${grant.credentialId}`,
    );
    if (
      !credential ||
      credential.createdBy !== identity.sub ||
      credential.authMode !== config().authMode ||
      Date.parse(credential.expiresAt) <= Date.now() ||
      JSON.stringify(credential.languages) !==
        JSON.stringify(grant.languages) ||
      credential.allowOverwrite !== grant.allowOverwrite
    )
      throw invalid();
    const guards: Change[] = [
      {
        pk: `PROJECT#${projectId}`,
        sk: `MCP_TOKEN#${credential.id}`,
        check: true,
        expectedVersion: credential.version,
      },
    ];
    if (credential.authMode === "local") {
      const user = await new LocalAuth(this.store).getUser(
        credential.createdBy.slice(6),
      );
      if (
        !user ||
        user.status !== "active" ||
        user.authVersion !== credential.ownerAuthVersion
      )
        throw invalid();
      try {
        authorize(userIdentity(user, 0), projectId, "manager");
      } catch {
        throw invalid();
      }
      guards.push({
        pk: "USERS",
        sk: `USER#${user.id}`,
        check: true,
        expectedVersion: user.version,
      });
    } else if (credential.authMode !== "demo") {
      if (
        !credential.ownerPrincipalId ||
        credential.ownerAuthVersion === undefined
      )
        throw invalid();
      guards.push(
        ...(await new SsoDirectory(this.store).guards(
          credential.ownerPrincipalId,
          credential.ownerAuthVersion,
          projectId,
        )),
      );
    }
    return guards;
  }
  async authenticate(request: Request): Promise<Identity> {
    const match =
      /^Bearer (keylo_mcp_([a-z0-9][a-z0-9-]{0,47})\.[a-f0-9]{64})$/.exec(
        request.headers.get("authorization") ?? "",
      );
    if (!match) throw invalid();
    const projectId = match[2]!;
    const id = hashToken(match[1]!);
    const pk = `PROJECT#${projectId}`,
      sk = `MCP_TOKEN#${id}`;
    const credential = await this.store.get<Credential>(pk, sk);
    if (
      !credential ||
      credential.authMode !== config().authMode ||
      Date.parse(credential.expiresAt) <= Date.now()
    )
      throw invalid();
    if (credential.authMode === "local") {
      const user = credential.createdBy.startsWith("local:")
        ? await new LocalAuth(this.store).getUser(credential.createdBy.slice(6))
        : undefined;
      if (
        !user ||
        user.status !== "active" ||
        user.authVersion !== credential.ownerAuthVersion
      )
        throw invalid();
      try {
        authorize(userIdentity(user, 0), projectId, "manager");
      } catch {
        throw invalid();
      }
    }
    if (credential.authMode === "okta" || credential.authMode === "saml") {
      if (
        !credential.ownerPrincipalId ||
        credential.ownerAuthVersion === undefined
      )
        throw invalid();
      await new SsoDirectory(this.store).guards(
        credential.ownerPrincipalId,
        credential.ownerAuthVersion,
        projectId,
      );
    }
    await new LocalAuth(this.store).limit(`mcp:${id}`, 120, 60);
    if (
      !credential.lastUsedAt ||
      Date.now() - Date.parse(credential.lastUsedAt) >= 60000
    ) {
      try {
        await this.store.put(
          pk,
          sk,
          {
            ...credential,
            lastUsedAt: new Date().toISOString(),
            version: credential.version + 1,
          },
          credential.version,
        );
      } catch (error) {
        if (!(error instanceof Conflict)) throw error;
        if (!(await this.store.get<Credential>(pk, sk))) throw invalid();
      }
    }
    return {
      sub: credential.createdBy,
      name: `Claude · ${credential.name}`,
      email: "",
      admin: false,
      projects: { [projectId]: "user" },
      mcp: {
        projectId,
        credentialId: id,
        languages: credential.languages,
        allowOverwrite: credential.allowOverwrite,
      },
    };
  }
}
export async function mcpCredentials() {
  return new McpCredentials(await getStore());
}
