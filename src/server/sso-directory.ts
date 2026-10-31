import { createHash, randomUUID } from "node:crypto";
import type { Identity } from "../shared";
import { config, required } from "./config";
import { HttpError } from "./errors";
import { Conflict, type Store, type Change } from "./store";
import { identityFromClaims } from "./auth";

export type SsoUser = {
  version: number;
  id: string;
  provider: "okta" | "saml";
  issuer: string;
  subject: string;
  userName: string;
  name: string;
  email: string;
  active: boolean;
  blocked: boolean;
  managed: boolean;
  authVersion: number;
  groups: string[];
  reconciledGroups?: string[];
  createdAt: string;
  updatedAt: string;
};
export type SsoGroup = {
  version: number;
  id: string;
  displayName: string;
  members: string[];
  createdAt: string;
  updatedAt: string;
};
export type DirectoryState = {
  version: number;
  groupsVersion: number;
  users: number;
  groups: number;
  memberships: number;
};
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const now = () => new Date().toISOString();
export function ssoScope() {
  const provider = config().authMode;
  if (provider !== "okta" && provider !== "saml")
    throw new HttpError(404, "SSO directory is not enabled.");
  const issuer = required(
    provider === "okta" ? "OKTA_ISSUER" : "SAML_IDP_ISSUER",
  );
  const mode = process.env.SSO_PROVISIONING_MODE ?? "jit";
  if (!["jit", "scim"].includes(mode))
    throw new Error("Invalid SSO_PROVISIONING_MODE.");
  return {
    provider,
    issuer,
    mode,
    pk: `SSO#${digest(JSON.stringify([provider, issuer]))}`,
  } as const;
}
export const principalId = (
  provider: string,
  issuer: string,
  subject: string,
) => digest(JSON.stringify([provider, issuer, subject]));
export function ssoAudit(
  action: string,
  actor: string,
  target?: string,
): Change {
  const at = now();
  return {
    pk: "AUTH_AUDIT",
    sk: `${at}#${randomUUID()}`,
    value: {
      version: 1,
      action,
      actor,
      ...(target ? { target } : {}),
      at,
      outcome: "success",
    },
  };
}
const membershipCaches = new WeakMap<
  Store,
  { pk: string; version: number; members: Map<string, string[]> }
>();
export class SsoDirectory {
  readonly scope = ssoScope();
  constructor(readonly store: Store) {}
  async state(): Promise<DirectoryState> {
    const existing = await this.store.get<DirectoryState>(
      this.scope.pk,
      "META",
    );
    if (existing) return existing;
    const initial = {
      version: 1,
      groupsVersion: 1,
      users: 0,
      groups: 0,
      memberships: 0,
    };
    try {
      await this.store.put(this.scope.pk, "META", initial);
      return initial;
    } catch (error) {
      if (!(error instanceof Conflict)) throw error;
      return (await this.store.get<DirectoryState>(this.scope.pk, "META"))!;
    }
  }
  async get(id: string) {
    return this.store.get<SsoUser>(this.scope.pk, `USER#${id}`);
  }
  async allUsers() {
    return this.store.list<SsoUser>(this.scope.pk, "USER#");
  }
  async allGroups() {
    return this.store.list<SsoGroup>(this.scope.pk, "GROUP#");
  }
  async membership(state: DirectoryState) {
    const cached = membershipCaches.get(this.store);
    if (cached?.pk === this.scope.pk && cached.version === state.groupsVersion)
      return cached.members;
    const groups = await this.allGroups();
    const latest = await this.state();
    if (latest.groupsVersion !== state.groupsVersion) throw new Conflict();
    const members = new Map<string, string[]>();
    for (const group of groups)
      for (const id of group.members) {
        const names = members.get(id) ?? [];
        names.push(group.displayName);
        members.set(id, names);
      }
    membershipCaches.set(this.store, {
      pk: this.scope.pk,
      version: state.groupsVersion,
      members,
    });
    return members;
  }
  async identity(
    user: SsoUser,
    authTime = 0,
    state?: DirectoryState,
  ): Promise<Identity> {
    if (
      !user.active ||
      user.blocked ||
      user.provider !== this.scope.provider ||
      user.issuer !== this.scope.issuer ||
      (this.scope.mode === "scim" && !user.managed)
    )
      throw new HttpError(
        401,
        "SSO account is disabled or is not provisioned.",
      );
    let groups =
      this.scope.mode === "scim"
        ? ((await this.membership(state ?? (await this.state()))).get(
            user.id,
          ) ?? [])
        : user.groups;
    if (user.reconciledGroups)
      groups = groups.filter((group) => user.reconciledGroups!.includes(group));
    const identity = identityFromClaims({
      sub:
        user.provider === "saml"
          ? `saml:${digest(JSON.stringify([user.issuer, user.subject]))}`
          : user.subject,
      name: user.name,
      email: user.email,
      groups,
    });
    return {
      ...identity,
      provider: user.provider,
      issuer: user.issuer,
      subject: user.subject,
      principalId: user.id,
      accessVersion: user.authVersion,
      authTime,
    };
  }
  async login(identity: Identity) {
    const issuer = identity.issuer ?? this.scope.issuer,
      subject = identity.subject ?? identity.sub;
    if (issuer !== this.scope.issuer || !subject || subject.length > 256)
      throw new HttpError(401, "Invalid SSO subject.");
    const id = principalId(this.scope.provider, issuer, subject);
    for (let attempt = 0; attempt < 8; attempt++) {
      const state = await this.state(),
        old = await this.get(id);
      if (this.scope.mode === "scim" && (!old?.managed || !old.active))
        throw new HttpError(
          401,
          "Provision this user through SCIM before signing in.",
        );
      if (old?.blocked || old?.active === false)
        throw new HttpError(401, "SSO account is disabled.");
      const groups = [
        ...(identity.admin ? ["keylo-admin"] : []),
        ...Object.entries(identity.projects).map(
          ([project, role]) => `keylo:${project}:${role}`,
        ),
      ].sort();
      if (groups.length > 501)
        throw new HttpError(413, "Too many SSO project assignments.");
      const effective = old && this.scope.mode === "scim" ? old.groups : groups;
      const changed =
        !!old && JSON.stringify(old.groups) !== JSON.stringify(effective);
      const next: SsoUser = {
        version: (old?.version ?? 0) + 1,
        id,
        provider: this.scope.provider,
        issuer,
        subject,
        userName: old?.userName ?? (identity.email || subject),
        name: identity.name.slice(0, 160),
        email: identity.email.slice(0, 254),
        active: true,
        blocked: false,
        managed: old?.managed ?? false,
        authVersion: (old?.authVersion ?? 1) + (changed ? 1 : 0),
        groups: effective,
        ...(old?.reconciledGroups
          ? { reconciledGroups: old.reconciledGroups }
          : {}),
        createdAt: old?.createdAt ?? now(),
        updatedAt: now(),
      };
      if (old && old.name === next.name && old.email === next.email && !changed)
        return { user: old, identity: await this.identity(old, 0, state) };
      if (!old && state.users >= 10000)
        throw new HttpError(413, "SSO directory user limit reached.");
      try {
        await this.store.transact([
          {
            pk: this.scope.pk,
            sk: `USER#${id}`,
            value: next,
            expectedVersion: old?.version,
          },
          {
            pk: this.scope.pk,
            sk: "META",
            value: {
              ...state,
              version: state.version + 1,
              users: state.users + (old ? 0 : 1),
            },
            expectedVersion: state.version,
          },
        ]);
        return { user: next, identity: await this.identity(next) };
      } catch (error) {
        if (!(error instanceof Conflict) || attempt === 7) throw error;
      }
    }
    throw new Conflict();
  }
  async resolve(id: string, authVersion: number, authTime: number) {
    const user = await this.get(id);
    if (!user || user.authVersion !== authVersion)
      throw new HttpError(401, "SSO access has been revoked.");
    return this.identity(user, authTime);
  }
  async guards(
    id: string,
    authVersion: number,
    project?: string,
    workspaceAdmin = false,
  ) {
    const state = await this.state(),
      user = await this.get(id);
    if (!user || user.authVersion !== authVersion)
      throw new HttpError(401, "SSO access has been revoked.");
    const identity = await this.identity(user, 0, state);
    if (workspaceAdmin && !identity.admin)
      throw new HttpError(403, "Workspace admin required.");
    if (
      project &&
      !identity.admin &&
      !["admin", "manager"].includes(identity.projects[project] ?? "")
    )
      throw new HttpError(
        401,
        "Connection owner no longer manages this project.",
      );
    return [
      {
        pk: this.scope.pk,
        sk: `USER#${id}`,
        check: true,
        expectedVersion: user.version,
      },
      {
        pk: this.scope.pk,
        sk: "META",
        check: true,
        expectedVersion: state.version,
      },
    ] satisfies Change[];
  }
  async requireAdmin(actor: Identity) {
    if (
      !actor.principalId ||
      actor.accessVersion === undefined ||
      !actor.authTime ||
      Date.now() / 1000 - actor.authTime > 900
    )
      throw new HttpError(401, "Sign in again to manage SSO access.");
    return this.guards(actor.principalId, actor.accessVersion, undefined, true);
  }
  async manage(
    actor: Identity,
    id: string,
    version: number,
    action: "block" | "unblock" | "revoke" | "reactivate",
  ) {
    const guards = await this.requireAdmin(actor),
      user = await this.get(id);
    if (!user) throw new HttpError(404, "User not found.");
    if (user.version !== version) throw new Conflict();
    if (id === actor.principalId && user.authVersion !== actor.accessVersion)
      throw new HttpError(401, "SSO access revoked.");
    if (action === "block" && id === actor.principalId)
      throw new HttpError(400, "You cannot block your own account.");
    const next = {
      ...user,
      version: user.version + 1,
      authVersion: user.authVersion + 1,
      updatedAt: now(),
      ...(action === "block"
        ? { blocked: true }
        : action === "unblock"
          ? { blocked: false }
          : action === "reactivate"
            ? { active: true }
            : {}),
    };
    // The target record itself guards a self-revocation; avoid duplicate DynamoDB operations.
    await this.store.transact([
      ...guards.filter((guard) => guard.sk !== `USER#${id}`),
      {
        pk: this.scope.pk,
        sk: `USER#${id}`,
        value: next,
        expectedVersion: user.version,
      },
      ssoAudit(`sso.user_${action}`, actor.sub, id),
    ]);
    return next;
  }
  async revokeSelf(actor: Identity) {
    if (!actor.principalId || actor.accessVersion === undefined)
      throw new HttpError(401, "SSO sign-in required.");
    const user = await this.get(actor.principalId);
    if (!user || user.authVersion !== actor.accessVersion)
      throw new HttpError(401, "SSO access revoked.");
    await this.store.transact([
      {
        pk: this.scope.pk,
        sk: `USER#${user.id}`,
        value: {
          ...user,
          version: user.version + 1,
          authVersion: user.authVersion + 1,
          updatedAt: now(),
        },
        expectedVersion: user.version,
      },
      ssoAudit("sso.all_access_revoked", actor.sub),
    ]);
  }
}
