import test from "node:test";
import assert from "node:assert/strict";
import type { AstroCookies } from "astro";
import { sqliteStore, type Store, type Change } from "../src/server/store";
import { ScimDirectory, handleScim } from "../src/server/scim";
import { Sessions } from "../src/server/sessions";
import { McpCredentials } from "../src/server/mcp-credentials";
import { KeyloService } from "../src/server/service";
import { SsoReconciler } from "../src/server/sso-reconcile";
import { HttpError } from "../src/server/errors";
import type { Identity } from "../src/shared";
process.env.AUTH_MODE = "okta";
process.env.OKTA_ISSUER = "https://idp.example.com/oauth2/default";
process.env.APP_ORIGIN = "https://copy.example.com";
process.env.SSO_PROVISIONING_MODE = "scim";
process.env.SSO_SCIM_TOKEN = "a".repeat(64);
const source: Identity = {
  sub: "00ualice",
  subject: "00ualice",
  issuer: process.env.OKTA_ISSUER,
  provider: "okta",
  name: "Alice",
  email: "alice@example.com",
  admin: true,
  projects: {},
};
const denied = (status: number) => (error: unknown) =>
  error instanceof HttpError && error.status === status;
function jar() {
  const values = new Map<string, string>();
  return {
    values,
    cookies: {
      get: (name: string) =>
        values.has(name) ? { value: values.get(name) } : undefined,
      set: (name: string, value: string) => values.set(name, value),
      delete: (name: string) => values.delete(name),
    } as unknown as AstroCookies,
  };
}
async function fixture() {
  const store = await sqliteStore(":memory:"),
    scim = new ScimDirectory(store),
    directory = scim.directory,
    svc = new KeyloService(store),
    sessions = new Sessions(store),
    credentials = new McpCredentials(store);
  const user = await scim.saveUser({
    externalId: source.subject,
    userName: source.email,
    displayName: source.name,
    emails: [{ value: source.email }],
    active: true,
  });
  const group = await scim.saveGroup({
    displayName: "keylo:website:manager",
    members: [{ value: user.id }],
  });
  await svc.createProject(source, {
    id: "website",
    name: "Website",
    sourceLanguage: "en",
    languages: [
      { code: "en", name: "English" },
      { code: "fr", name: "French" },
    ],
  });
  await svc.createKey(source, "website", {
    name: "welcome",
    translations: { en: "Hello {name}", fr: "" },
  });
  const cookies = jar();
  await sessions.create(cookies.cookies, { identity: source, maxAge: 3600 });
  const identity = (await sessions.resolve(cookies.cookies))!;
  const issued = await credentials.create(identity, "website", {
    name: "Claude",
    languages: ["fr"],
  });
  const request = new Request("https://copy.example.com/mcp", {
    headers: { authorization: `Bearer ${issued.secret}` },
  });
  return {
    store,
    scim,
    directory,
    svc,
    sessions,
    credentials,
    user,
    group,
    cookies,
    identity,
    issued,
    request,
  };
}
test("SCIM is a separate authenticated boundary with equality filtering and standard errors", async () => {
  const { store, user } = await fixture();
  const request = (path: string, token = "a".repeat(64)) =>
    new Request(`https://copy.example.com/scim/v2/${path}`, {
      headers: { authorization: `Bearer ${token}` },
    });
  assert.equal((await handleScim(request("Users", "bad"), store)).status, 401);
  const listed = await handleScim(
    request(
      "Users?filter=" + encodeURIComponent('userName eq "alice@example.com"'),
    ),
    store,
  );
  assert.equal(
    listed.headers.get("content-type"),
    "application/scim+json; charset=utf-8",
  );
  const data = await listed.json();
  assert.equal(data.totalResults, 1);
  assert.equal(data.Resources[0].id, user.id);
  assert.equal(
    (
      await handleScim(
        request("Users?filter=" + encodeURIComponent('userName co "alice"')),
        store,
      )
    ).status,
    400,
  );
  assert.equal(
    (await handleScim(request("Users?count=1000"), store)).status,
    400,
  );
});
test("SCIM roles replace signed-in group claims, and unprovisioned subjects cannot log in", async () => {
  const f = await fixture();
  assert.equal(f.identity.admin, false);
  assert.equal(f.identity.projects.website, "manager");
  await assert.rejects(
    f.sessions.create(jar().cookies, {
      identity: { ...source, subject: "unknown", sub: "unknown" },
      maxAge: 3600,
    }),
    denied(401),
  );
  const claimOnly = { ...source, projects: { website: "admin" as const } };
  await f.sessions.create(f.cookies.cookies, {
    identity: claimOnly,
    maxAge: 3600,
  });
  assert.equal(
    (await f.sessions.resolve(f.cookies.cookies))!.projects.website,
    "manager",
  );
});
test("offboarding revokes SSO sessions and MCP credentials while preserving contributions", async () => {
  const f = await fixture();
  await f.svc.setMcpTranslations(
    await f.credentials.authenticate(f.request),
    "website",
    {
      updates: [
        {
          key: "welcome",
          expectedVersion: 1,
          translations: { fr: "Bonjour {name}" },
        },
      ],
    },
  );
  await f.scim.patch(
    "Users",
    f.user.id,
    {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: [{ op: "replace", value: { active: false } }],
    },
    null,
  );
  assert.equal(await f.sessions.resolve(f.cookies.cookies), undefined);
  await assert.rejects(f.credentials.authenticate(f.request), denied(401));
  assert.equal(
    (await f.svc.key(source, "website", "welcome")).translations.fr,
    "Bonjour {name}",
  );
  await assert.rejects(
    f.scim.saveUser(
      {
        ...(await f.scim.userView((await f.directory.get(f.user.id))!)),
        active: true,
      },
      f.user.id,
    ),
    denied(412),
  );
  const user = (await f.directory.get(f.user.id))!;
  await f.scim.saveUser(
    { ...(await f.scim.userView(user)), active: true },
    user.id,
    `W/"${user.version}"`,
  );
  await assert.rejects(f.credentials.authenticate(f.request), denied(401));
});
test("group removal changes existing browser permissions and invalidates MCP use immediately", async () => {
  const f = await fixture();
  await f.scim.saveGroup(
    { displayName: f.group.displayName, members: [] },
    f.group.id,
  );
  const identity = (await f.sessions.resolve(f.cookies.cookies))!;
  assert.deepEqual(Object.keys(identity.projects), []);
  await assert.rejects(f.credentials.authenticate(f.request), denied(401));
});
test("MCP transaction guards block a revocation racing its final write", async () => {
  const f = await fixture(),
    identity = await f.credentials.authenticate(f.request);
  let fired = false;
  const wrapped: Store = {
    ...f.store,
    async transact(changes: Change[]) {
      if (!fired && changes.some((change) => change.sk === "KEY#welcome")) {
        fired = true;
        await f.credentials.revoke(
          f.identity,
          "website",
          f.issued.credential.id,
        );
      }
      return f.store.transact(changes);
    },
  };
  await assert.rejects(
    new KeyloService(wrapped).setMcpTranslations(identity, "website", {
      updates: [
        {
          key: "welcome",
          expectedVersion: 1,
          translations: { fr: "Bonjour {name}" },
        },
      ],
    }),
    denied(401),
  );
  assert.equal(
    (await f.svc.key(source, "website", "welcome")).translations.fr,
    "",
  );
});
test("MCP transaction guards block a membership change racing its final write", async () => {
  const f = await fixture(),
    identity = await f.credentials.authenticate(f.request);
  let fired = false;
  const wrapped: Store = {
    ...f.store,
    async transact(changes: Change[]) {
      if (!fired && changes.some((change) => change.sk === "KEY#welcome")) {
        fired = true;
        await f.scim.saveGroup(
          { displayName: f.group.displayName, members: [] },
          f.group.id,
        );
      }
      return f.store.transact(changes);
    },
  };
  await assert.rejects(
    new KeyloService(wrapped).setMcpTranslations(identity, "website", {
      updates: [
        {
          key: "welcome",
          expectedVersion: 1,
          translations: { fr: "Bonjour {name}" },
        },
      ],
    }),
    denied(401),
  );
  assert.equal(
    (await f.svc.key(source, "website", "welcome")).translations.fr,
    "",
  );
});
test("SCIM renames do not rebind identity; stale versions and subject changes are rejected", async () => {
  const f = await fixture();
  const next = await f.scim.saveUser(
    { ...(await f.scim.userView(f.user)), userName: "renamed@example.com" },
    f.user.id,
    `W/"${f.user.version}"`,
  );
  assert.equal(next.id, f.user.id);
  assert.equal(
    (await f.sessions.resolve(f.cookies.cookies))!.principalId,
    f.user.id,
  );
  await assert.rejects(
    f.scim.saveUser(
      { ...(await f.scim.userView(next)), active: false },
      next.id,
      `W/"${f.user.version}"`,
    ),
    denied(412),
  );
  await assert.rejects(
    f.scim.saveUser(
      { ...(await f.scim.userView(next)), externalId: "other" },
      next.id,
    ),
    denied(400),
  );
});
test("group PATCH add/remove operations are atomic and retry-safe", async () => {
  const f = await fixture();
  const patch = {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
    Operations: [{ op: "remove", path: `members[value eq "${f.user.id}"]` }],
  };
  await f.scim.patch("Groups", f.group.id, patch, null);
  await f.scim.patch("Groups", f.group.id, patch, null);
  assert.equal((await f.directory.allGroups())[0]!.members.length, 0);
  await assert.rejects(
    f.scim.patch(
      "Groups",
      f.group.id,
      {
        ...patch,
        Operations: [
          { op: "replace", path: "members", value: [{ value: f.user.id }] },
        ],
      },
      `W/"${f.group.version}"`,
    ),
    denied(412),
  );
});
test("reconciliation catches missing assignments and never forwards secrets to a pagination origin", async () => {
  const f = await fixture();
  const settings = {
    origin: "https://idp.example.com",
    appId: "0oaapp",
    apiToken: "token".repeat(8),
  };
  const fake: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, settings.origin);
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      `SSWS ${settings.apiToken}`,
    );
    return url.pathname.includes("/apps/")
      ? new Response(null, { status: 404 })
      : Response.json({ id: source.subject, status: "ACTIVE" });
  };
  await new SsoReconciler(f.store, settings, fake).inspect(
    (await f.directory.get(f.user.id))!,
  );
  assert.equal((await f.directory.get(f.user.id))!.active, false);
  await assert.rejects(f.credentials.authenticate(f.request), denied(401));
  const second = await fixture();
  const malicious: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/groups"))
      return Response.json([{ profile: { name: "keylo:website:manager" } }], {
        headers: { link: '<https://attacker.example/groups>; rel="next"' },
      });
    return Response.json({ id: source.subject, status: "ACTIVE" });
  };
  await assert.rejects(
    new SsoReconciler(second.store, settings, malicious).inspect(
      (await second.directory.get(second.user.id))!,
    ),
    /pagination/,
  );
  assert.equal((await second.directory.get(second.user.id))!.active, true);
});
test("reconciliation errors retain local state and report failures for retry", async () => {
  const f = await fixture();
  const fake: typeof fetch = async () => new Response(null, { status: 429 });
  const result = await new SsoReconciler(
    f.store,
    {
      origin: "https://idp.example.com",
      appId: "app",
      apiToken: "a".repeat(32),
    },
    fake,
  ).run();
  assert.equal(result.status, "partial-failure");
  assert.equal(result.failures, 1);
  assert.equal((await f.directory.get(f.user.id))!.active, true);
});

test("admin blocking survives profile updates and self-revocation invalidates existing access", async () => {
  const f = await fixture();
  await f.scim.saveGroup({
    displayName: "keylo-admin",
    members: [{ value: f.user.id }],
  });
  const admin = (await f.sessions.resolve(f.cookies.cookies))!;
  await assert.rejects(
    f.directory.manage(
      admin,
      f.user.id,
      (await f.directory.get(f.user.id))!.version,
      "block",
    ),
    denied(400),
  );
  const other = await f.scim.saveUser({
    externalId: "00ubob",
    userName: "bob@example.com",
    active: true,
  });
  await f.directory.manage(admin, other.id, other.version, "block");
  await f.scim.saveUser(
    {
      ...(await f.scim.userView((await f.directory.get(other.id))!)),
      displayName: "Bob renamed",
    },
    other.id,
  );
  assert.equal((await f.directory.get(other.id))!.blocked, true);
  await assert.rejects(
    f.directory.login({ ...source, subject: "00ubob", sub: "00ubob" }),
    denied(401),
  );
  await f.directory.revokeSelf(admin);
  assert.equal(await f.sessions.resolve(f.cookies.cookies), undefined);
  await assert.rejects(f.credentials.authenticate(f.request), denied(401));
});

test("a failed early reconciliation batch never marks a later batch as a successful complete cycle", async () => {
  const f = await fixture();
  for (let i = 0; i < 101; i++) {
    const user = {
      ...f.user,
      id: i.toString(16).padStart(64, "0"),
      subject: `00user${i}`,
    };
    await f.store.put(f.directory.scope.pk, `USER#${user.id}`, user);
  }
  let fail = true;
  const fetcher: typeof fetch = async (input) => {
    const subject = decodeURIComponent(
      new URL(String(input)).pathname.split("/").at(-1)!,
    );
    if (fail && subject === "00user0")
      return new Response("{}", { status: 429 });
    return Response.json({ id: subject, status: "SUSPENDED" });
  };
  const job = new SsoReconciler(
    f.store,
    {
      origin: "https://idp.example.com",
      appId: "app",
      apiToken: "x".repeat(32),
    },
    fetcher,
  );
  assert.equal((await job.run()).status, "partial-failure");
  assert.equal((await job.run()).cycleComplete, true);
  assert.equal(
    (await f.store.get<any>(f.directory.scope.pk, "RECONCILE"))
      .lastCompleteCycle,
    undefined,
  );
  fail = false;
  await job.run();
  await job.run();
  assert.ok(
    (await f.store.get<any>(f.directory.scope.pk, "RECONCILE"))
      .lastCompleteCycle,
  );
});

test("reconciliation rejects disabled app assignments even when the organization user remains active", async () => {
  for (const status of [
    "SUSPENDED",
    "DEPROVISIONED",
    "REVOKED",
    "PROVISIONED",
    "ACTIVE",
  ]) {
    const f = await fixture();
    const fetcher: typeof fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/groups"))
        return Response.json([{ profile: { name: "keylo:website:manager" } }]);
      return Response.json({
        id: source.subject,
        status: path.includes("/apps/") ? status : "ACTIVE",
      });
    };
    await new SsoReconciler(
      f.store,
      {
        origin: "https://idp.example.com",
        appId: "app",
        apiToken: "a".repeat(32),
      },
      fetcher,
    ).inspect((await f.directory.get(f.user.id))!);
    assert.equal(
      (await f.directory.get(f.user.id))!.active,
      ["ACTIVE", "PROVISIONED"].includes(status),
    );
  }
});

test("an administrator losing its pushed group cannot commit a competing access edit", async () => {
  const f = await fixture();
  const group = await f.scim.saveGroup({
    displayName: "keylo-admin",
    members: [{ value: f.user.id }],
  });
  const admin = (await f.sessions.resolve(f.cookies.cookies))!;
  const other = await f.scim.saveUser({
    externalId: "00ubob",
    userName: "bob@example.com",
    active: true,
  });
  let race = true;
  const racing: Store = {
    ...f.store,
    transact: async (changes) => {
      if (
        race &&
        changes.some(
          (change) => change.sk === `USER#${other.id}` && change.value,
        )
      ) {
        race = false;
        await f.scim.saveGroup(
          { displayName: group.displayName, members: [] },
          group.id,
        );
      }
      return f.store.transact(changes);
    },
  };
  const { SsoDirectory } = await import("../src/server/sso-directory");
  await assert.rejects(
    new SsoDirectory(racing).manage(admin, other.id, other.version, "block"),
  );
  assert.equal((await f.directory.get(other.id))!.blocked, false);
  await assert.rejects(f.directory.requireAdmin(admin), denied(403));
});
