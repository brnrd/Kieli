import test from "node:test";
import assert from "node:assert/strict";
import type { AstroCookies } from "astro";
import { LocalAuth, digest, userIdentity } from "../src/server/local-auth";
import { Sessions, sessionCookie } from "../src/server/sessions";
import { hashPassword, verifyPassword } from "../src/server/passwords";
import { authorize, HttpError } from "../src/server/auth";
import { sqliteStore } from "../src/server/store";
import { config } from "../src/server/config";
import { KieliService } from "../src/server/service";

process.env.AUTH_MODE = "local";
process.env.APP_ORIGIN = "http://localhost:4321";
process.env.STORAGE_DRIVER = "sqlite";
const password = "Voyager-kestrel-silver-83! drawer";
const nextPassword = "Prairie-ember-royal-92! spindle";
const now = () => Math.floor(Date.now() / 1000);
const token = (url: string) => new URL(url).searchParams.get("token")!;
const isStatus = (status: number) => (error: unknown) =>
  error instanceof HttpError && error.status === status;
function cookieJar(initial?: string) {
  const values = new Map<string, string>(
    initial ? [[sessionCookie, initial]] : [],
  );
  const options: Record<string, unknown> = {};
  const cookies = {
    get: (name: string) =>
      values.has(name) ? { value: values.get(name) } : undefined,
    set: (name: string, value: string, settings: unknown) => {
      values.set(name, value);
      options[name] = settings;
    },
    delete: (name: string) => {
      values.delete(name);
    },
  } as unknown as AstroCookies;
  return { cookies, values, options };
}
async function fixture() {
  const store = await sqliteStore(":memory:");
  const auth = new LocalAuth(store);
  const sessions = new Sessions(store);
  const created = await auth.bootstrap({
    email: "admin@example.com",
    name: "Workspace admin",
  });
  const user = await auth.acceptLink(
    { token: token(created.url), password },
    "fixture",
  );
  const identity = userIdentity(user, now());
  return { store, auth, sessions, user, identity };
}
async function member(
  f: Awaited<ReturnType<typeof fixture>>,
  extra: Record<string, unknown> = {},
) {
  const invited = await f.auth.invite(f.identity, {
    email: "member@example.com",
    name: "Team member",
    ...extra,
  });
  const user = await f.auth.acceptLink(
    { token: token(invited.url), password },
    "member",
  );
  return { user, identity: userIdentity(user, now()) };
}
test("passwords use salted Argon2id, reject weak choices, and preserve normalized Unicode", async () => {
  const first = await hashPassword(password);
  const second = await hashPassword(password);
  assert.match(first, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  assert.notEqual(first, second);
  assert.equal(await verifyPassword(first, password), true);
  assert.equal(await verifyPassword(first, "incorrect"), false);
  await assert.rejects(hashPassword("passwordpassword"), isStatus(400));
  await assert.rejects(hashPassword("short"), isStatus(400));
  await assert.rejects(hashPassword("x".repeat(129)), isStatus(400));
  const unicode = await hashPassword("Cafe\u0301 " + password);
  assert.equal(await verifyPassword(unicode, "Café " + password), true);
});
test("bootstrap is operator-only and one-time; invitations store only token hashes", async () => {
  const store = await sqliteStore(":memory:");
  const auth = new LocalAuth(store);
  const invitation = await auth.bootstrap({
    email: "ADMIN@example.com",
    name: "Admin",
  });
  assert.equal(invitation.user.email, "admin@example.com");
  assert.equal(invitation.user.status, "invited");
  assert.equal(invitation.user.hasPassword, false);
  const secret = token(invitation.url);
  assert.match(secret, /^[a-f0-9]{64}$/);
  assert.equal(await store.get(`SETUP#${secret}`, "META"), undefined);
  const stored = await store.get<Record<string, unknown>>(
    `SETUP#${digest(secret)}`,
    "META",
  );
  assert.ok(stored);
  assert.equal(JSON.stringify(stored).includes(secret), false);
  await assert.rejects(
    auth.bootstrap({ email: "second@example.com", name: "Second" }),
    isStatus(409),
  );
  await assert.rejects(
    auth.acceptLink({ token: secret, password: "passwordpassword" }, "setup"),
    isStatus(400),
  );
  const active = await auth.acceptLink({ token: secret, password }, "setup");
  assert.equal(active.status, "active");
  await assert.rejects(
    auth.acceptLink({ token: secret, password }, "setup"),
    isStatus(400),
  );
  assert.equal(
    (await store.get<{ activeAdmins: number }>("AUTH_CONTROL", "ADMINS"))
      ?.activeAdmins,
    1,
  );
});
test("sign-in does not disclose unknown, disabled, invited, or incorrect-password accounts", async () => {
  const f = await fixture();
  const invited = await f.auth.invite(f.identity, {
    email: "invited@example.com",
    name: "Invited",
  });
  const m = await member(f);
  await f.auth.updateUser(f.identity, m.user.id, {
    version: m.user.version,
    name: m.user.name,
    workspaceRole: "member",
    projects: {},
    status: "disabled",
  });
  for (const email of [
    "unknown@example.com",
    "member@example.com",
    invited.user.email,
    "admin@example.com",
  ]) {
    await assert.rejects(
      f.auth.login(
        {
          email,
          password: email === "admin@example.com" ? "incorrect" : password,
        },
        "sign-in",
      ),
      (error: unknown) =>
        error instanceof HttpError &&
        error.status === 401 &&
        error.message === "Email or password is incorrect.",
    );
  }
  assert.equal(
    (await f.auth.login({ email: " ADMIN@example.com ", password }, "sign-in"))
      .id,
    f.user.id,
  );
});
test("users are administered with default-deny roles, recent sign-in, and project validation", async () => {
  const f = await fixture();
  const m = await member(f);
  await assert.rejects(f.auth.list(m.identity, { limit: 50 }), isStatus(403));
  await assert.rejects(
    f.auth.invite(
      { ...m.identity, admin: true },
      {
        email: "escalate@example.com",
        name: "Escalate",
        workspaceRole: "admin",
      },
    ),
    isStatus(403),
  );
  await assert.rejects(
    f.auth.list({ ...f.identity, authTime: now() - 901 }, { limit: 50 }),
    isStatus(401),
  );
  await assert.rejects(
    f.auth.invite(f.identity, {
      email: "bad@example.com",
      name: "Bad",
      projects: { unknown: "admin" },
    }),
    isStatus(400),
  );
  const page = await f.auth.list(f.identity, { limit: 1 });
  assert.equal(page.items.length, 1);
  assert.ok(page.nextCursor);
  const serialized = JSON.stringify(page);
  assert.equal(serialized.includes("passwordHash"), false);
  assert.equal(serialized.includes("authVersion"), false);
  const filtered = await f.auth.list(f.identity, {
    limit: 50,
    query: "member@",
  });
  assert.equal(filtered.items[0]?.id, m.user.id);
});
test("server-side sessions use short opaque cookies and logout prevents cookie replay", async () => {
  const f = await fixture();
  const jar = cookieJar();
  await f.sessions.create(jar.cookies, { user: f.user });
  const secret = jar.values.get(sessionCookie)!;
  assert.equal(secret.length, 64);
  assert.equal(
    (jar.options[sessionCookie] as { httpOnly: boolean }).httpOnly,
    true,
  );
  assert.equal((await f.sessions.resolve(jar.cookies))?.sub, f.identity.sub);
  await f.sessions.revoke(jar.cookies);
  assert.equal(jar.values.has(sessionCookie), false);
  assert.equal(await f.sessions.resolve(cookieJar(secret).cookies), undefined);
  assert.equal(
    await f.store.get(`SESSION#${digest(secret)}`, "META"),
    undefined,
  );
});
test("large membership sets stay off the cookie and role changes invalidate existing sessions", async () => {
  const f = await fixture();
  const roles: Record<string, "user"> = {};
  const svc = new KieliService(f.store);
  for (let i = 0; i < 120; i++) {
    const id = `project-${i}`;
    roles[id] = "user";
    await svc.createProject(f.identity, {
      id,
      name: id,
      sourceLanguage: "en",
      languages: [{ code: "en", name: "English" }],
    });
  }
  const m = await member(f, { projects: roles });
  const jar = cookieJar();
  await f.sessions.create(jar.cookies, { user: m.user });
  assert.equal(jar.values.get(sessionCookie)!.length, 64);
  const identity = await f.sessions.resolve(jar.cookies);
  assert.equal(Object.keys(identity!.projects).length, 120);
  authorize(identity!, "project-119");
  await f.auth.updateUser(f.identity, m.user.id, {
    version: m.user.version,
    name: m.user.name,
    workspaceRole: "member",
    projects: { "project-0": "manager" },
    status: "active",
  });
  assert.equal(await f.sessions.resolve(jar.cookies), undefined);
  const fresh = await f.auth.login(
    { email: m.user.email, password },
    "membership",
  );
  await f.sessions.create(jar.cookies, { user: fresh });
  const updated = await f.sessions.resolve(jar.cookies);
  assert.equal(updated?.projects["project-0"], "manager");
  assert.throws(() => authorize(updated!, "project-119"), isStatus(403));
});
test("disabling a user revokes sessions and blocks login and outstanding password links", async () => {
  const f = await fixture();
  const m = await member(f);
  const jar = cookieJar();
  await f.sessions.create(jar.cookies, { user: m.user });
  const reset = await f.auth.setupLink(f.identity, m.user.id, m.user.version);
  await f.auth.updateUser(f.identity, m.user.id, {
    version: reset.user.version,
    name: m.user.name,
    workspaceRole: "member",
    projects: {},
    status: "disabled",
  });
  assert.equal(await f.sessions.resolve(jar.cookies), undefined);
  await assert.rejects(
    f.auth.login({ email: m.user.email, password }, "disabled"),
    isStatus(401),
  );
  await assert.rejects(
    f.auth.acceptLink(
      { token: token(reset.url), password: nextPassword },
      "disabled",
    ),
    isStatus(400),
  );
});
test("password-reset links are single-use, expire, and revoke previous sessions", async () => {
  const f = await fixture();
  const m = await member(f);
  const jar = cookieJar();
  await f.sessions.create(jar.cookies, { user: m.user });
  const reset = await f.auth.setupLink(f.identity, m.user.id, m.user.version);
  const secret = token(reset.url);
  const results = await Promise.allSettled(
    [1, 2].map(() =>
      f.auth.acceptLink(
        { token: secret, password: nextPassword },
        "reset-race",
      ),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);
  assert.equal(await f.sessions.resolve(jar.cookies), undefined);
  await assert.rejects(
    f.auth.login({ email: m.user.email, password }, "reset"),
    isStatus(401),
  );
  const updated = await f.auth.login(
    { email: m.user.email, password: nextPassword },
    "reset",
  );
  const expired = await f.auth.setupLink(
    f.identity,
    updated.id,
    updated.version,
  );
  const pk = `SETUP#${digest(token(expired.url))}`;
  const row = await f.store.get<{
    version: number;
    ttl: number;
    [key: string]: unknown;
  }>(pk, "META");
  await f.store.put(pk, "META", { ...row!, ttl: now() - 1 }, 1);
  await assert.rejects(
    f.auth.acceptLink({ token: token(expired.url), password }, "expired"),
    isStatus(400),
  );
});
test("the last active admin cannot be disabled or demoted, even by concurrent admins", async () => {
  const f = await fixture();
  const change = {
    version: f.user.version,
    name: f.user.name,
    workspaceRole: "member",
    projects: {},
    status: "active",
  };
  await assert.rejects(
    f.auth.updateUser(f.identity, f.user.id, change),
    isStatus(400),
  );
  const second = await member(f, { workspaceRole: "admin" });
  const results = await Promise.allSettled(
    [
      { user: f.user, identity: f.identity },
      { user: second.user, identity: second.identity },
    ].map(({ user, identity }) =>
      f.auth.updateUser(identity, user.id, {
        version: user.version,
        name: user.name,
        workspaceRole: "admin",
        projects: {},
        status: "disabled",
      }),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);
  assert.equal(
    (await f.store.get<{ activeAdmins: number }>("AUTH_CONTROL", "ADMINS"))
      ?.activeAdmins,
    1,
  );
});
test("password changes and explicit session revocation invalidate all older sessions", async () => {
  const f = await fixture();
  const m = await member(f);
  const first = cookieJar();
  const second = cookieJar();
  await f.sessions.create(first.cookies, { user: m.user });
  await f.sessions.create(second.cookies, { user: m.user });
  await assert.rejects(
    f.auth.changePassword(m.identity, {
      currentPassword: "incorrect",
      newPassword: nextPassword,
    }),
    isStatus(400),
  );
  const updated = await f.auth.changePassword(m.identity, {
    currentPassword: password,
    newPassword: nextPassword,
  });
  assert.equal(await f.sessions.resolve(first.cookies), undefined);
  assert.equal(await f.sessions.resolve(second.cookies), undefined);
  await f.sessions.create(first.cookies, { user: updated });
  assert.ok(await f.sessions.resolve(first.cookies));
  await f.auth.revokeSessions(f.identity, updated.id, updated.version);
  assert.equal(await f.sessions.resolve(first.cookies), undefined);
});
test("idle and absolute session expiry are enforced without relying on database TTL cleanup", async () => {
  const f = await fixture();
  for (const expired of ["idle", "absolute"]) {
    const jar = cookieJar();
    await f.sessions.create(jar.cookies, { user: f.user });
    const pk = `SESSION#${digest(jar.values.get(sessionCookie)!)}`;
    const row = await f.store.get<{
      version: number;
      ttl: number;
      lastSeen: number;
      [key: string]: unknown;
    }>(pk, "META");
    await f.store.put(
      pk,
      "META",
      {
        ...row!,
        ...(expired === "idle"
          ? { lastSeen: now() - 1801 }
          : { ttl: now() - 1 }),
      },
      1,
    );
    assert.equal(await f.sessions.resolve(jar.cookies), undefined);
  }
});
test("login throttling is shared across service instances and cannot exceed its atomic counter", async () => {
  const store = await sqliteStore(":memory:");
  const services = [new LocalAuth(store), new LocalAuth(store)];
  const results = await Promise.allSettled(
    Array.from({ length: 15 }, (_, i) =>
      services[i % 2]!.limit("shared-account", 5),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 5);
  assert.equal(
    results.filter(
      (r) =>
        r.status === "rejected" &&
        r.reason instanceof HttpError &&
        r.reason.status === 429,
    ).length,
    10,
  );
});
test("security events omit credentials, are paginated newest-first, and enforce admin access", async () => {
  const f = await fixture();
  const m = await member(f);
  await f.auth.login({ email: m.user.email, password }, "audit");
  const events = await f.auth.audit(f.identity, 50);
  const text = JSON.stringify(events);
  assert.equal(text.includes(password), false);
  assert.equal(text.includes("passwordHash"), false);
  assert.equal(text.includes("SETUP#"), false);
  assert.ok(events.items.some((event) => event.action === "user.activated"));
  assert.ok(events.items.some((event) => event.action === "login.succeeded"));
  assert.deepEqual(
    events.items.map((e) => e.at),
    events.items
      .map((e) => e.at)
      .sort()
      .reverse(),
  );
  await assert.rejects(f.auth.audit(m.identity, 50), isStatus(403));
});
test("operator recovery revokes prior sessions and issues a fresh one-time admin link", async () => {
  const f = await fixture();
  const jar = cookieJar();
  await f.sessions.create(jar.cookies, { user: f.user });
  const recovered = await f.auth.recover(f.user.email);
  assert.equal(await f.sessions.resolve(jar.cookies), undefined);
  const user = await f.auth.acceptLink(
    { token: token(recovered.url), password: nextPassword },
    "recovery",
  );
  assert.equal(user.workspaceRole, "admin");
});
test("auth mode boundaries and HTTPS production requirements fail closed", async () => {
  const f = await fixture();
  const previous = process.env.AUTH_MODE;
  process.env.AUTH_MODE = "okta";
  const origin = process.env.APP_ORIGIN;
  process.env.APP_ORIGIN = "https://copy.example.com";
  try {
    await assert.rejects(
      f.auth.bootstrap({ email: "other@example.com", name: "Other" }),
      isStatus(404),
    );
  } finally {
    process.env.AUTH_MODE = previous;
    process.env.APP_ORIGIN = origin;
  }
  const production = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    assert.throws(config, /HTTPS/);
  } finally {
    if (production === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = production;
  }
});
test("Okta uses the same revocable opaque sessions with secure cookies and a one-hour cap", async () => {
  const store = await sqliteStore(":memory:");
  const sessions = new Sessions(store);
  const previousMode = process.env.AUTH_MODE;
  const previousOrigin = process.env.APP_ORIGIN;
  const previousIssuer = process.env.OKTA_ISSUER;
  process.env.OKTA_ISSUER = "https://idp.example.com/oauth2/default";
  process.env.AUTH_MODE = "okta";
  process.env.APP_ORIGIN = "https://copy.example.com";
  try {
    const jar = cookieJar();
    await sessions.create(jar.cookies, {
      identity: {
        sub: "okta-user",
        name: "SSO user",
        email: "sso@example.com",
        admin: false,
        projects: { website: "manager" },
      },
      maxAge: 7200,
    });
    const secret = jar.values.get(sessionCookie)!;
    assert.equal(secret.length, 64);
    assert.equal(
      (jar.options[sessionCookie] as { secure: boolean }).secure,
      true,
    );
    const row = await store.get<{ ttl: number; authTime: number }>(
      `SESSION#${digest(secret)}`,
      "META",
    );
    assert.equal(row!.ttl - row!.authTime, 3600);
    const identity = await sessions.resolve(jar.cookies);
    assert.equal(identity?.provider, "okta");
    assert.equal(identity?.projects.website, "manager");
    await sessions.revoke(jar.cookies);
    assert.equal(await sessions.resolve(cookieJar(secret).cookies), undefined);
    assert.equal(
      await sessions.resolve(cookieJar("legacy.encrypted.cookie").cookies),
      undefined,
    );
    process.env.AUTH_MODE = "local";
    assert.equal(await sessions.resolve(cookieJar(secret).cookies), undefined);
  } finally {
    if (previousIssuer === undefined) delete process.env.OKTA_ISSUER;
    else process.env.OKTA_ISSUER = previousIssuer;
    process.env.AUTH_MODE = previousMode;
    process.env.APP_ORIGIN = previousOrigin;
  }
});
