import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Identity, LocalUserView, Project, Role } from "../shared";
import { config } from "./config";
import { HttpError } from "./errors";
import {
  Conflict,
  getStore,
  type Change,
  type RecordValue,
  type Store,
} from "./store";
import { dummyPasswordHash, hashPassword, verifyPassword } from "./passwords";

export type LocalUser = Omit<LocalUserView, "hasPassword"> & {
  passwordHash?: string;
  authVersion: number;
  searchText: string;
};
type Control = { version: number; activeAdmins: number };
type SetupLink = {
  version: number;
  userId: string;
  authVersion: number;
  purpose: "activate" | "reset";
  ttl: number;
};
type RateLimit = { version: number; attempts: number; ttl: number };
export const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const seconds = () => Math.floor(Date.now() / 1000);
const stamp = () => new Date().toISOString();
const record = (value: object) => value as RecordValue;
const emailSchema = z
  .string()
  .trim()
  .max(254)
  .pipe(z.email())
  .transform((value) => value.toLowerCase());
const roleMap = z
  .record(
    z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/),
    z.enum(["admin", "manager", "user"]),
  )
  .refine(
    (roles) => Object.keys(roles).length <= 500,
    "Assign at most 500 projects per user.",
  );
const newUserSchema = z
  .object({
    email: emailSchema,
    name: z.string().trim().min(1).max(80),
    workspaceRole: z.enum(["admin", "member"]).default("member"),
    projects: roleMap.default({}),
  })
  .strict();
const activeAdmin = (user: LocalUser) =>
  user.status === "active" && user.workspaceRole === "admin";
export function userIdentity(user: LocalUser, authTime: number): Identity {
  return {
    sub: `local:${user.id}`,
    name: user.name,
    email: user.email,
    admin: user.workspaceRole === "admin",
    projects: user.projects,
    provider: "local",
    authTime,
  };
}
function view(user: LocalUser): LocalUserView {
  const { passwordHash, authVersion, searchText, ...safe } = user;
  return { ...safe, hasPassword: !!passwordHash };
}
function audit(action: string, actor: string, target?: string): Change {
  const at = stamp();
  return {
    pk: "AUTH_AUDIT",
    sk: `${at}#${randomUUID()}`,
    value: { version: 1, action, actor, ...(target ? { target } : {}), at },
  };
}
function loginFailure() {
  return new HttpError(401, "Email or password is incorrect.");
}
function invalidLink() {
  return new HttpError(
    400,
    "This link is invalid or expired. Ask your workspace administrator for a new one.",
  );
}
export class LocalAuth {
  constructor(private store: Store) {}
  private localOnly() {
    if (config().authMode !== "local")
      throw new HttpError(404, "Built-in user management is not enabled.");
  }
  async getUser(id: string) {
    return this.store.get<LocalUser>("USERS", `USER#${id}`);
  }
  private async byEmail(email: string) {
    const index = await this.store.get<{ userId: string }>(
      `EMAIL#${digest(email)}`,
      "META",
    );
    return index ? this.getUser(index.userId) : undefined;
  }
  private async requireAdmin(identity: Identity) {
    this.localOnly();
    const actor =
      identity.provider === "local" && identity.sub.startsWith("local:")
        ? await this.getUser(identity.sub.slice(6))
        : undefined;
    if (!actor || !activeAdmin(actor) || !identity.admin)
      throw new HttpError(
        403,
        "Only an active workspace admin can manage users.",
      );
    if (!identity.authTime || seconds() - identity.authTime > 900)
      throw new HttpError(401, "Sign in again to manage workspace access.");
    return actor;
  }
  private async validateProjects(projects: Record<string, Role>) {
    for (const id of Object.keys(projects))
      if (!(await this.store.get<Project>("WORKSPACE", `PROJECT#${id}`)))
        throw new HttpError(400, `Unknown project: ${id}.`);
  }
  private link(user: LocalUser) {
    const secret = randomBytes(32).toString("hex");
    const expiresAt = seconds() + (user.passwordHash ? 1800 : 86400);
    const stored: SetupLink = {
      version: 1,
      userId: user.id,
      authVersion: user.authVersion,
      purpose: user.passwordHash ? "reset" : "activate",
      ttl: expiresAt,
    };
    return {
      change: {
        pk: `SETUP#${digest(secret)}`,
        sk: "META",
        value: record(stored),
      },
      url: `${config().origin}/auth/setup?token=${secret}`,
      expiresAt: new Date(expiresAt * 1000).toISOString(),
    };
  }
  private makeUser(input: z.infer<typeof newUserSchema>): LocalUser {
    return {
      ...input,
      id: randomUUID(),
      status: "invited",
      version: 1,
      authVersion: 1,
      createdAt: stamp(),
      updatedAt: stamp(),
      searchText: `${input.name}\n${input.email}`.toLowerCase(),
    };
  }
  // Operator-only entry point, exposed by the CLI, never an unauthenticated HTTP route.
  async bootstrap(input: unknown) {
    this.localOnly();
    const parsed = newUserSchema.parse(input);
    if (await this.store.get<Control>("AUTH_CONTROL", "ADMINS"))
      throw new HttpError(
        409,
        "An administrator has already been initialized. Use users:recover to issue a new link for that account.",
      );
    const user = this.makeUser({
      ...parsed,
      workspaceRole: "admin",
      projects: {},
    });
    const link = this.link(user);
    await this.store.transact([
      {
        pk: "AUTH_CONTROL",
        sk: "ADMINS",
        value: { version: 1, activeAdmins: 0 },
      },
      { pk: "USERS", sk: `USER#${user.id}`, value: record(user) },
      {
        pk: `EMAIL#${digest(user.email)}`,
        sk: "META",
        value: { version: 1, userId: user.id },
      },
      link.change,
      audit("user.bootstrap", "operator", user.id),
    ]);
    return { user: view(user), url: link.url, expiresAt: link.expiresAt };
  }
  async recover(email: string) {
    this.localOnly();
    const user = await this.byEmail(emailSchema.parse(email));
    if (!user || user.workspaceRole !== "admin" || user.status === "disabled")
      throw new HttpError(
        404,
        "An enabled local administrator with that email was not found.",
      );
    const next = {
      ...user,
      authVersion: user.authVersion + 1,
      version: user.version + 1,
      updatedAt: stamp(),
    };
    const link = this.link(next);
    await this.store.transact([
      {
        pk: "USERS",
        sk: `USER#${user.id}`,
        value: record(next),
        expectedVersion: user.version,
      },
      link.change,
      audit("user.recovery", "operator", user.id),
    ]);
    return { user: view(next), url: link.url, expiresAt: link.expiresAt };
  }
  async list(
    identity: Identity,
    options: { limit: number; cursor?: string; query?: string },
  ) {
    await this.requireAdmin(identity);
    const page = await this.store.page<LocalUser>("USERS", "USER#", options);
    return { ...page, items: page.items.map(view) };
  }
  async invite(identity: Identity, input: unknown) {
    const actor = await this.requireAdmin(identity);
    const parsed = newUserSchema.parse(input);
    await this.validateProjects(parsed.projects);
    if (await this.byEmail(parsed.email))
      throw new HttpError(
        409,
        "A user with this email already exists. Use their activation or reset action.",
      );
    const user = this.makeUser(parsed);
    const link = this.link(user);
    await this.store.transact([
      { pk: "USERS", sk: `USER#${user.id}`, value: record(user) },
      {
        pk: `EMAIL#${digest(user.email)}`,
        sk: "META",
        value: { version: 1, userId: user.id },
      },
      link.change,
      audit("user.invited", actor.id, user.id),
    ]);
    return { user: view(user), url: link.url, expiresAt: link.expiresAt };
  }
  private async update(
    user: LocalUser,
    next: LocalUser,
    event: Change,
    extras: Change[] = [],
  ) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const changes: Change[] = [
        {
          pk: "USERS",
          sk: `USER#${user.id}`,
          value: record(next),
          expectedVersion: user.version,
        },
        event,
        ...extras,
      ];
      const delta = Number(activeAdmin(next)) - Number(activeAdmin(user));
      if (delta) {
        const control = await this.store.get<Control>("AUTH_CONTROL", "ADMINS");
        if (!control)
          throw new HttpError(
            409,
            "Initialize the first administrator before managing users.",
          );
        if (control.activeAdmins + delta < 1)
          throw new HttpError(
            400,
            "Keep at least one active workspace admin. Activate another admin before changing this account.",
          );
        changes.push({
          pk: "AUTH_CONTROL",
          sk: "ADMINS",
          value: {
            ...control,
            activeAdmins: control.activeAdmins + delta,
            version: control.version + 1,
          },
          expectedVersion: control.version,
        });
      }
      try {
        await this.store.transact(changes);
        return;
      } catch (error) {
        if (!(error instanceof Conflict) || attempt === 7) throw error;
        if ((await this.getUser(user.id))?.version !== user.version)
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
      }
    }
  }
  async updateUser(identity: Identity, id: string, input: unknown) {
    const actor = await this.requireAdmin(identity);
    const data = z
      .object({
        version: z.number().int().positive(),
        name: z.string().trim().min(1).max(80),
        workspaceRole: z.enum(["admin", "member"]),
        status: z.enum(["active", "invited", "disabled"]),
        projects: roleMap,
      })
      .strict()
      .parse(input);
    const user = await this.getUser(id);
    if (!user) throw new HttpError(404, "User not found.");
    if (data.version !== user.version) throw new Conflict();
    if (data.status === "active" && !user.passwordHash)
      throw new HttpError(
        400,
        "This user must choose a password using their activation link.",
      );
    if (data.status === "invited" && user.passwordHash)
      throw new HttpError(400, "An activated user can be active or disabled.");
    await this.validateProjects(data.projects);
    const next = {
      ...user,
      ...data,
      version: user.version + 1,
      authVersion: user.authVersion + 1,
      searchText: `${data.name}\n${user.email}`.toLowerCase(),
      updatedAt: stamp(),
    };
    await this.update(
      user,
      next,
      audit("user.access_changed", actor.id, user.id),
    );
    return view(next);
  }
  async setupLink(identity: Identity, id: string, version: number) {
    const actor = await this.requireAdmin(identity);
    const user = await this.getUser(id);
    if (!user) throw new HttpError(404, "User not found.");
    if (user.version !== version) throw new Conflict();
    if (user.status === "disabled")
      throw new HttpError(400, "Enable this account before issuing a link.");
    const next = { ...user, version: user.version + 1, updatedAt: stamp() };
    const link = this.link(next);
    await this.update(
      user,
      next,
      audit(
        user.passwordHash ? "user.reset_issued" : "user.activation_issued",
        actor.id,
        user.id,
      ),
      [link.change],
    );
    return { user: view(next), url: link.url, expiresAt: link.expiresAt };
  }
  async revokeSessions(identity: Identity, id: string, version: number) {
    const actor = await this.requireAdmin(identity);
    const user = await this.getUser(id);
    if (!user) throw new HttpError(404, "User not found.");
    if (user.version !== version) throw new Conflict();
    const next = {
      ...user,
      version: user.version + 1,
      authVersion: user.authVersion + 1,
      updatedAt: stamp(),
    };
    await this.update(
      user,
      next,
      audit("user.sessions_revoked", actor.id, user.id),
    );
    return view(next);
  }
  async limit(key: string, maximum: number, window = 900) {
    const bucket = Math.floor(seconds() / window);
    const pk = `AUTH_RATE#${digest(key)}`;
    const sk = String(bucket);
    for (let attempt = 0; attempt < 8; attempt++) {
      const previous = await this.store.get<RateLimit>(pk, sk);
      if ((previous?.attempts ?? 0) >= maximum)
        throw new HttpError(429, "Too many attempts. Try again later.");
      const next = {
        version: (previous?.version ?? 0) + 1,
        attempts: (previous?.attempts ?? 0) + 1,
        ttl: (bucket + 2) * window,
      };
      try {
        await this.store.put(pk, sk, next, previous?.version);
        return;
      } catch (error) {
        if (!(error instanceof Conflict) || attempt === 7) throw error;
      }
    }
  }
  async login(input: unknown, client: string) {
    this.localOnly();
    const data = z
      .object({ email: z.string().max(254), password: z.string().max(1024) })
      .strict()
      .parse(input);
    const email = data.email.trim().toLowerCase();
    await this.limit(`account:${email}`, 10);
    await this.limit(`client:${client}`, 1000);
    const dummy = await dummyPasswordHash();
    const user = await this.byEmail(email);
    const permitted = user?.status === "active" && !!user.passwordHash;
    const matches = await verifyPassword(
      permitted ? user!.passwordHash! : dummy,
      data.password,
    );
    if (!permitted || !matches) {
      const entry = audit("login.failed", "anonymous", digest(email));
      await this.store.put(entry.pk, entry.sk, entry.value!);
      throw loginFailure();
    }
    const entry = audit("login.succeeded", user!.id);
    await this.store.put(entry.pk, entry.sk, entry.value!);
    return user!;
  }
  async acceptLink(input: unknown, client: string) {
    this.localOnly();
    const data = z
      .object({
        token: z.string().regex(/^[a-f0-9]{64}$/),
        password: z.string().max(1024),
      })
      .strict()
      .parse(input);
    await this.limit(`setup:${client}`, 30);
    const pk = `SETUP#${digest(data.token)}`;
    const link = await this.store.get<SetupLink>(pk, "META");
    if (!link || link.ttl <= seconds()) throw invalidLink();
    const user = await this.getUser(link.userId);
    if (
      !user ||
      user.status === "disabled" ||
      user.authVersion !== link.authVersion
    )
      throw invalidLink();
    const passwordHash = await hashPassword(data.password, [
      user.name,
      user.email,
    ]);
    const next: LocalUser = {
      ...user,
      passwordHash,
      status: "active",
      authVersion: user.authVersion + 1,
      version: user.version + 1,
      updatedAt: stamp(),
    };
    try {
      await this.update(
        user,
        next,
        audit(
          link.purpose === "activate"
            ? "user.activated"
            : "user.password_reset",
          user.id,
        ),
        [{ pk, sk: "META", expectedVersion: link.version }],
      );
    } catch (error) {
      if (error instanceof Conflict) throw invalidLink();
      throw error;
    }
    return next;
  }
  async changePassword(identity: Identity, input: unknown) {
    this.localOnly();
    const data = z
      .object({
        currentPassword: z.string().max(1024),
        newPassword: z.string().max(1024),
      })
      .strict()
      .parse(input);
    const user =
      identity.provider === "local"
        ? await this.getUser(identity.sub.slice(6))
        : undefined;
    if (!user || user.status !== "active" || !user.passwordHash)
      throw new HttpError(403, "An active local account is required.");
    await this.limit(`password:${user.id}`, 10);
    if (!(await verifyPassword(user.passwordHash, data.currentPassword)))
      throw new HttpError(400, "Your current password is incorrect.");
    const passwordHash = await hashPassword(data.newPassword, [
      user.name,
      user.email,
    ]);
    const next = {
      ...user,
      passwordHash,
      authVersion: user.authVersion + 1,
      version: user.version + 1,
      updatedAt: stamp(),
    };
    await this.update(user, next, audit("user.password_changed", user.id));
    return next;
  }
  async audit(identity: Identity, limit: number, cursor?: string) {
    await this.requireAdmin(identity);
    return this.store.page<{
      action: string;
      actor: string;
      target?: string;
      at: string;
    }>("AUTH_AUDIT", "", { limit, cursor, reverse: true });
  }
}
export async function localAuth() {
  return new LocalAuth(await getStore());
}
