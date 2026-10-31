import { createHash, timingSafeEqual, randomUUID } from "node:crypto";
import { z, ZodError } from "zod";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import {
  SsoDirectory,
  ssoAudit,
  principalId,
  type SsoUser,
  type SsoGroup,
} from "./sso-directory";
import { Conflict, type Change, type Store } from "./store";
import { HttpError } from "./errors";
import { readBody } from "./http";
import { canonicalJSON } from "../canonical-json";
const USER = "urn:ietf:params:scim:schemas:core:2.0:User",
  GROUP = "urn:ietf:params:scim:schemas:core:2.0:Group";
const ERROR = "urn:ietf:params:scim:api:messages:2.0:Error",
  LIST = "urn:ietf:params:scim:api:messages:2.0:ListResponse",
  PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const time = () => new Date().toISOString();
const obj = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
let secretCache: { arn: string; value: string; until: number } | undefined;
export async function scimSecret() {
  const arn = process.env.SSO_SCIM_SECRET_ARN;
  if (arn) {
    if (secretCache?.arn === arn && secretCache.until > Date.now())
      return secretCache.value;
    const secret = await new SecretsManagerClient({}).send(
      new GetSecretValueCommand({ SecretId: arn }),
    );
    if (!secret.SecretString || secret.SecretString.length < 32)
      throw new Error("Invalid SCIM secret.");
    secretCache = {
      arn,
      value: secret.SecretString,
      until: Date.now() + 300000,
    };
    return secret.SecretString;
  }
  const token = process.env.SSO_SCIM_TOKEN;
  if (!token || token.length < 32)
    throw new HttpError(503, "SCIM credential is not configured.");
  return token;
}
export class ScimDirectory {
  readonly directory: SsoDirectory;
  constructor(readonly store: Store) {
    this.directory = new SsoDirectory(store);
  }
  private pk() {
    return this.directory.scope.pk;
  }
  async userView(user: SsoUser, allGroups?: SsoGroup[]) {
    const groups = (allGroups ?? (await this.directory.allGroups()))
      .filter((group) => group.members.includes(user.id))
      .map((group) => ({ value: group.id, display: group.displayName }));
    return {
      schemas: [USER],
      id: user.id,
      externalId: user.subject,
      userName: user.userName,
      displayName: user.name,
      name: { formatted: user.name },
      emails: user.email
        ? [{ value: user.email, primary: true, type: "work" }]
        : [],
      active: user.active && !user.blocked,
      groups,
      meta: {
        resourceType: "User",
        created: user.createdAt,
        lastModified: user.updatedAt,
        version: `W/"${user.version}"`,
      },
    };
  }
  groupView(group: SsoGroup) {
    return {
      schemas: [GROUP],
      id: group.id,
      displayName: group.displayName,
      members: group.members.map((value) => ({ value })),
      meta: {
        resourceType: "Group",
        created: group.createdAt,
        lastModified: group.updatedAt,
        version: `W/"${group.version}"`,
      },
    };
  }
  private inputUser(input: unknown) {
    const parsed = z
      .object({
        externalId: z.string().trim().min(1).max(256),
        userName: z.string().trim().min(1).max(254),
        active: z.boolean().default(true),
        displayName: z.string().max(160).optional(),
        name: z
          .object({
            formatted: z.string().max(160).optional(),
            givenName: z.string().max(80).optional(),
            familyName: z.string().max(80).optional(),
          })
          .loose()
          .optional(),
        emails: z
          .array(
            z
              .object({
                value: z.string().max(254),
                primary: z.boolean().optional(),
              })
              .loose(),
          )
          .max(10)
          .optional(),
      })
      .loose()
      .parse(input);
    const name =
      parsed.displayName ??
      parsed.name?.formatted ??
      ([parsed.name?.givenName, parsed.name?.familyName]
        .filter(Boolean)
        .join(" ") ||
        parsed.userName);
    const email =
      parsed.emails?.find((email) => email.primary)?.value ??
      parsed.emails?.[0]?.value ??
      "";
    return {
      subject: parsed.externalId,
      userName: parsed.userName,
      name,
      email,
      active: parsed.active,
    };
  }
  private precondition(
    old: { version: number } | undefined,
    etag: string | null,
  ) {
    if (etag && (!old || etag !== `W/"${old.version}"`))
      throw new HttpError(
        412,
        "SCIM resource changed. Read it again before updating.",
      );
  }
  async saveUser(input: unknown, id?: string, etag: string | null = null) {
    const data = this.inputUser(input),
      computed = principalId(
        this.directory.scope.provider,
        this.directory.scope.issuer,
        data.subject,
      );
    if (id && id !== computed)
      throw new HttpError(
        400,
        "externalId is immutable and must match the SSO subject.",
      );
    for (let attempt = 0; attempt < 8; attempt++) {
      const state = await this.directory.state(),
        old = await this.directory.get(computed);
      this.precondition(old, etag);
      if (id && !old) throw new HttpError(404, "User not found.");
      if (!id && old?.managed) throw new HttpError(409, "User already exists.");
      if (old?.active === false && data.active && !etag)
        throw new HttpError(
          412,
          "Reactivation needs the current resource ETag or an explicit administrator action.",
        );
      const index = `USERNAME#${hash(data.userName.toLowerCase())}`;
      const existing = await this.store.get<{ version: number; id: string }>(
        this.pk(),
        index,
      );
      if (existing && existing.id !== computed)
        throw new HttpError(409, "userName is already assigned.");
      if (!old && state.users >= 10000)
        throw new HttpError(413, "SSO user limit reached.");
      const next: SsoUser = {
        ...data,
        version: (old?.version ?? 0) + 1,
        id: computed,
        provider: this.directory.scope.provider,
        issuer: this.directory.scope.issuer,
        blocked: old?.blocked ?? false,
        managed: true,
        authVersion:
          (old?.authVersion ?? 1) +
          (old && (!old.managed || old.active !== data.active) ? 1 : 0),
        groups: [],
        ...(old?.reconciledGroups
          ? { reconciledGroups: old.reconciledGroups }
          : {}),
        createdAt: old?.createdAt ?? time(),
        updatedAt: time(),
      };
      if (
        old?.managed &&
        canonicalJSON({
          ...next,
          version: old.version,
          updatedAt: old.updatedAt,
        }) === canonicalJSON(old)
      )
        return old;
      const changes: Change[] = [
        {
          pk: this.pk(),
          sk: `USER#${computed}`,
          value: next,
          expectedVersion: old?.version,
        },
        {
          pk: this.pk(),
          sk: "META",
          value: {
            ...state,
            version: state.version + 1,
            users: state.users + (old ? 0 : 1),
          },
          expectedVersion: state.version,
        },
        ssoAudit(
          old ? "scim.user_updated" : "scim.user_created",
          "scim",
          computed,
        ),
      ];
      if (!existing)
        changes.push({
          pk: this.pk(),
          sk: index,
          value: { version: 1, id: computed },
        });
      if (old && old.userName.toLowerCase() !== data.userName.toLowerCase()) {
        const previous = `USERNAME#${hash(old.userName.toLowerCase())}`;
        const record = await this.store.get<{ version: number; id: string }>(
          this.pk(),
          previous,
        );
        if (record?.id === computed)
          changes.push({
            pk: this.pk(),
            sk: previous,
            expectedVersion: record.version,
          });
      }
      try {
        await this.store.transact(changes);
        return next;
      } catch (error) {
        if (!(error instanceof Conflict) || attempt === 7) throw error;
      }
    }
    throw new Conflict();
  }
  async saveGroup(input: unknown, id?: string, etag: string | null = null) {
    const data = z
      .object({
        displayName: z.string().trim().min(1).max(160),
        members: z
          .array(
            z.object({ value: z.string().regex(/^[a-f0-9]{64}$/) }).loose(),
          )
          .max(1000)
          .default([]),
      })
      .loose()
      .parse(input);
    const members = [
      ...new Set(data.members.map((member) => member.value)),
    ].sort();
    const groupId = id ?? randomUUID();
    for (let attempt = 0; attempt < 8; attempt++) {
      const state = await this.directory.state(),
        old = await this.store.get<SsoGroup>(this.pk(), `GROUP#${groupId}`);
      this.precondition(old, etag);
      if (id && !old) throw new HttpError(404, "Group not found.");
      if (
        old?.displayName === data.displayName &&
        canonicalJSON(old.members) === canonicalJSON(members)
      )
        return old;
      const userIds = new Set(
        (await this.directory.allUsers()).map((user) => user.id),
      );
      if (members.some((member) => !userIds.has(member)))
        throw new HttpError(
          400,
          "Group references a user not provisioned in this directory.",
        );
      const nameIndex = `GROUPNAME#${hash(data.displayName)}`,
        taken = await this.store.get<{ version: number; id: string }>(
          this.pk(),
          nameIndex,
        );
      if (taken && taken.id !== groupId)
        throw new HttpError(409, "Group displayName must be unique.");
      const size =
        state.memberships - (old?.members.length ?? 0) + members.length;
      if (size > 50000 || (!old && state.groups >= 2000))
        throw new HttpError(413, "Directory group/membership limit reached.");
      const next: SsoGroup = {
        id: groupId,
        version: (old?.version ?? 0) + 1,
        displayName: data.displayName,
        members,
        createdAt: old?.createdAt ?? time(),
        updatedAt: time(),
      };
      const changes: Change[] = [
        {
          pk: this.pk(),
          sk: `GROUP#${groupId}`,
          value: next,
          expectedVersion: old?.version,
        },
        {
          pk: this.pk(),
          sk: "META",
          value: {
            ...state,
            version: state.version + 1,
            groupsVersion: state.groupsVersion + 1,
            groups: state.groups + (old ? 0 : 1),
            memberships: size,
          },
          expectedVersion: state.version,
        },
        ssoAudit("scim.group_updated", "scim", groupId),
      ];
      if (!taken)
        changes.push({
          pk: this.pk(),
          sk: nameIndex,
          value: { version: 1, id: groupId },
        });
      if (old && old.displayName !== data.displayName)
        changes.push({
          pk: this.pk(),
          sk: `GROUPNAME#${hash(old.displayName)}`,
          expectedVersion: 1,
        });
      try {
        await this.store.transact(changes);
        return next;
      } catch (error) {
        if (!(error instanceof Conflict) || attempt === 7) throw error;
      }
    }
    throw new Conflict();
  }
  async patch(
    kind: "Users" | "Groups",
    id: string,
    input: unknown,
    etag: string | null,
  ) {
    const parsed = z
      .object({
        schemas: z.array(z.string()).refine((value) => value.includes(PATCH)),
        Operations: z
          .array(
            z
              .object({
                op: z.string(),
                path: z.string().optional(),
                value: z.unknown().optional(),
              })
              .strict(),
          )
          .min(1)
          .max(100),
      })
      .strict()
      .parse(input);
    const original =
      kind === "Users"
        ? await this.directory.get(id)
        : await this.store.get<SsoGroup>(this.pk(), `GROUP#${id}`);
    if (!original) throw new HttpError(404, "Resource not found.");
    this.precondition(original, etag);
    const current: Record<string, unknown> =
      kind === "Users"
        ? await this.userView(original as SsoUser)
        : this.groupView(original as SsoGroup);
    if (kind === "Users") current.active = (original as SsoUser).active;
    for (const operation of parsed.Operations) {
      const op = operation.op.toLowerCase(),
        path = operation.path;
      if (!["add", "replace", "remove"].includes(op))
        throw new HttpError(400, "Unsupported PATCH operation.");
      if (!path) {
        if (op === "remove" || !obj(operation.value))
          throw new HttpError(400, "PATCH without a path requires an object.");
        for (const [name, value] of Object.entries(operation.value)) {
          if (
            ![
              "active",
              "userName",
              "displayName",
              "name",
              "emails",
              "members",
            ].includes(name)
          )
            throw new HttpError(400, "Unsupported PATCH attribute.");
          if (name === "members" && kind !== "Groups")
            throw new HttpError(400, "User group membership is read-only.");
          current[name] =
            name === "members" && op === "add"
              ? [
                  ...(current.members as unknown[]),
                  ...z.array(z.unknown()).parse(value),
                ]
              : value;
        }
      } else if (kind === "Groups" && path.startsWith("members")) {
        const filter = /^members\[value eq "([a-f0-9]{64})"\]$/.exec(path);
        if (op === "remove") {
          if (path !== "members" && !filter)
            throw new HttpError(400, "Unsupported membership filter.");
          current.members = filter
            ? (current.members as { value: string }[]).filter(
                (member) => member.value !== filter[1],
              )
            : [];
        } else {
          if (path !== "members")
            throw new HttpError(400, "Unsupported membership filter.");
          const values = z.array(z.unknown()).parse(operation.value);
          current.members =
            op === "add"
              ? [...(current.members as unknown[]), ...values]
              : values;
        }
      } else {
        if (
          !["active", "userName", "displayName", "name", "emails"].includes(
            path,
          ) ||
          (kind === "Groups" && path !== "displayName")
        )
          throw new HttpError(400, "Unsupported PATCH path.");
        if (op === "remove") {
          if (["active", "userName"].includes(path))
            throw new HttpError(400, "Required attribute cannot be removed.");
          delete current[path];
        } else current[path] = operation.value;
      }
    }
    // Bind read/modify/write to the captured version even for unversioned clients.
    // A race yields 412 instead of silently restoring a removed membership.
    const version = `W/"${original.version}"`;
    if (kind === "Users") {
      if (
        (original as SsoUser).active === false &&
        current.active === true &&
        !etag
      )
        throw new HttpError(412, "Reactivation requires a current ETag.");
      return this.userView(await this.saveUser(current, id, version));
    }
    return this.groupView(await this.saveGroup(current, id, version));
  }
  async remove(kind: "Users" | "Groups", id: string, etag: string | null) {
    if (kind === "Users") {
      const user = await this.directory.get(id);
      if (!user) throw new HttpError(404, "User not found.");
      return this.saveUser(
        { ...(await this.userView(user)), active: false },
        id,
        etag,
      );
    }
    for (let attempt = 0; attempt < 8; attempt++) {
      const state = await this.directory.state(),
        group = await this.store.get<SsoGroup>(this.pk(), `GROUP#${id}`);
      if (!group) return;
      this.precondition(group, etag);
      try {
        await this.store.transact([
          { pk: this.pk(), sk: `GROUP#${id}`, expectedVersion: group.version },
          {
            pk: this.pk(),
            sk: `GROUPNAME#${hash(group.displayName)}`,
            expectedVersion: 1,
          },
          {
            pk: this.pk(),
            sk: "META",
            value: {
              ...state,
              version: state.version + 1,
              groupsVersion: state.groupsVersion + 1,
              groups: state.groups - 1,
              memberships: state.memberships - group.members.length,
            },
            expectedVersion: state.version,
          },
          ssoAudit("scim.group_deleted", "scim", id),
        ]);
        return;
      } catch (error) {
        if (!(error instanceof Conflict) || attempt === 7) throw error;
      }
    }
  }
}
function response(value: unknown, status = 200) {
  const version =
    obj(value) && obj(value.meta) ? value.meta.version : undefined;
  return Response.json(value, {
    status,
    headers: {
      "Content-Type": "application/scim+json; charset=utf-8",
      "Cache-Control": "no-store",
      ...(typeof version === "string" ? { ETag: version } : {}),
    },
  });
}
export async function handleScim(
  request: Request,
  store: Store,
): Promise<Response> {
  try {
    const scim = new ScimDirectory(store);
    if (scim.directory.scope.mode !== "scim")
      throw new HttpError(404, "SCIM provisioning is not enabled.");
    const expected = hash(await scimSecret()),
      match = /^Bearer ([^\s]{32,512})$/.exec(
        request.headers.get("authorization") ?? "",
      );
    if (
      !timingSafeEqual(
        Buffer.from(expected),
        Buffer.from(hash(match?.[1] ?? "")),
      )
    )
      throw new HttpError(401, "A valid SCIM credential is required.");
    const url = new URL(request.url),
      parts = url.pathname
        .replace(/^\/scim\/v2\/?/, "")
        .split("/")
        .filter(Boolean),
      kind = parts[0],
      id = parts[1];
    if (
      parts.length === 1 &&
      kind === "ServiceProviderConfig" &&
      request.method === "GET"
    )
      return response({
        schemas: [
          "urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig",
        ],
        patch: { supported: true },
        bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
        filter: { supported: true, maxResults: 100 },
        changePassword: { supported: false },
        sort: { supported: false },
        etag: { supported: true },
        authenticationSchemes: [
          {
            type: "oauthbearertoken",
            name: "Provisioning bearer token",
            description: "Dedicated operator-configured credential",
            primary: true,
          },
        ],
      });
    if (
      !["Users", "Groups"].includes(kind ?? "") ||
      parts.length > 2 ||
      (id && !/^(?:[a-f0-9]{64}|[a-f0-9-]{36})$/.test(id))
    )
      throw new HttpError(404, "SCIM endpoint not found.");
    const resource = kind as "Users" | "Groups",
      etag = request.headers.get("if-match");
    if (request.method === "GET") {
      if (id) {
        const stored =
          resource === "Users"
            ? await scim.directory.get(id)
            : await store.get<SsoGroup>(scim.directory.scope.pk, `GROUP#${id}`);
        if (!stored) throw new HttpError(404, "Resource not found.");
        return response(
          resource === "Users"
            ? await scim.userView(stored as SsoUser)
            : scim.groupView(stored as SsoGroup),
        );
      }
      const count = Number(url.searchParams.get("count") ?? 100),
        start = Number(url.searchParams.get("startIndex") ?? 1);
      if (
        !Number.isSafeInteger(count) ||
        count < 0 ||
        count > 100 ||
        !Number.isSafeInteger(start) ||
        start < 1
      )
        throw new HttpError(400, "Invalid SCIM pagination.");
      let records: (SsoUser | SsoGroup)[] =
        resource === "Users"
          ? (await scim.directory.allUsers()).filter((user) => user.managed)
          : await scim.directory.allGroups();
      const filter = url.searchParams.get("filter");
      if (filter) {
        const match =
          /^(userName|externalId|displayName|id) eq "([^"\\]{1,256})"$/.exec(
            filter,
          );
        if (
          !match ||
          (resource === "Users" && match[1] === "displayName") ||
          (resource === "Groups" && !["displayName", "id"].includes(match[1]!))
        )
          throw new HttpError(
            400,
            "Only supported equality filters are allowed.",
          );
        records = records.filter((record) =>
          match[1] === "userName"
            ? (record as SsoUser).userName.toLowerCase() ===
              match[2]!.toLowerCase()
            : String(
                (record as unknown as Record<string, unknown>)[
                  match[1] === "externalId" ? "subject" : match[1]!
                ] ?? "",
              ) === match[2],
        );
      }
      const page = records.slice(start - 1, start - 1 + count),
        groups =
          resource === "Users" ? await scim.directory.allGroups() : undefined;
      return response({
        schemas: [LIST],
        totalResults: records.length,
        startIndex: start,
        itemsPerPage: page.length,
        Resources: await Promise.all(
          page.map((record) =>
            resource === "Users"
              ? scim.userView(record as SsoUser, groups)
              : scim.groupView(record as SsoGroup),
          ),
        ),
      });
    }
    if (request.method === "DELETE" && id) {
      await scim.remove(resource, id, etag);
      return new Response(null, { status: 204 });
    }
    if (
      !["POST", "PUT", "PATCH"].includes(request.method) ||
      (request.method === "POST" ? !!id : !id)
    )
      throw new HttpError(405, "Unsupported SCIM method.");
    if (
      !/^application\/(?:scim\+)?json(?:;|$)/i.test(
        request.headers.get("content-type") ?? "",
      )
    )
      throw new HttpError(415, "Send application/scim+json.");
    let body: unknown;
    try {
      body = JSON.parse((await readBody(request)).toString("utf8"));
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, "Invalid JSON.");
    }
    if (request.method === "PATCH")
      return response(await scim.patch(resource, id!, body, etag));
    const saved =
      resource === "Users"
        ? await scim.userView(await scim.saveUser(body, id, etag))
        : scim.groupView(await scim.saveGroup(body, id, etag));
    return response(saved, request.method === "POST" ? 201 : 200);
  } catch (error) {
    const status =
      error instanceof HttpError
        ? error.status
        : error instanceof Conflict
          ? 409
          : error instanceof ZodError
            ? 400
            : 500;
    const detail =
      error instanceof HttpError
        ? error.message
        : error instanceof ZodError
          ? "Invalid SCIM resource."
          : error instanceof Conflict
            ? "Resource changed; retry from a fresh read."
            : "Unable to process provisioning request.";
    return response(
      {
        schemas: [ERROR],
        status: String(status),
        detail,
        ...(status === 409 ? { scimType: "uniqueness" } : {}),
      },
      status,
    );
  }
}
