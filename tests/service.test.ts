import test from "node:test";
import assert from "node:assert/strict";
import { ZodError } from "zod";
import { KieliService } from "../src/server/service";
import { Conflict, getStore, sqliteStore } from "../src/server/store";
import {
  authenticate,
  authorize,
  checkOrigin,
  hashToken,
  HttpError,
  identityFromClaims,
  seal,
} from "../src/server/auth";
import { config } from "../src/server/config";
import type { Identity, Token } from "../src/shared";
import type { AstroCookies } from "astro";

process.env.AUTH_MODE = "demo";
process.env.STORAGE_DRIVER = "sqlite";
process.env.SQLITE_PATH = ":memory:";
process.env.SESSION_SECRET = "0123456789abcdef".repeat(4);
const admin: Identity = {
  sub: "a",
  name: "Admin",
  email: "admin@example.com",
  admin: true,
  projects: {},
};
const manager: Identity = {
  ...admin,
  sub: "m",
  name: "Manager",
  admin: false,
  projects: { website: "manager" },
};
const user: Identity = {
  ...admin,
  sub: "u",
  name: "Translator",
  admin: false,
  projects: { website: "user" },
};
const outsider: Identity = { ...user, projects: { other: "manager" } };
const project = {
  id: "website",
  name: "Website",
  description: "",
  sourceLanguage: "en",
  languages: [
    { code: "en", name: "English" },
    { code: "fr", name: "French" },
  ],
};
const key = {
  name: "home.title",
  namespace: "home",
  translations: { en: "Hello {name}", fr: "" },
};
async function fixture() {
  const store = await sqliteStore(":memory:");
  const svc = new KieliService(store);
  await svc.createProject(admin, project);
  return { svc, store };
}
const denied = (status: number) => (error: unknown) =>
  error instanceof HttpError && error.status === status;

test("Okta groups grant exact project roles and preserve the highest role", () => {
  const identity = identityFromClaims({
    sub: "okta-user",
    groups: [
      "unrelated",
      "kieli:website:manager",
      "kieli:website:user",
      "kieli:other:user",
    ],
  });
  assert.equal(identity.projects.website, "manager");
  assert.equal(identity.projects.other, "user");
  assert.equal(identity.admin, false);
  assert.throws(() => authorize(identity, "web", "user"), denied(403));
  assert.equal(
    identityFromClaims({ sub: "admin", groups: ["kieli-admin"] }).admin,
    true,
  );
});
test("workspace creation and project data enforce role boundaries", async () => {
  const { svc } = await fixture();
  await assert.rejects(
    svc.createProject(manager, { ...project, id: "new" }),
    denied(403),
  );
  await assert.rejects(svc.keys(outsider, "website"), denied(403));
  await assert.rejects(svc.createKey(user, "website", key), denied(403));
  assert.deepEqual((await svc.bootstrap(outsider)).projects, []);
  assert.equal((await svc.bootstrap(user)).projects[0]?.id, "website");
});
test("users can edit target translations but cannot edit source copy, metadata, settings, tokens, or delete keys", async () => {
  const { svc } = await fixture();
  const created = await svc.createKey(manager, "website", key);
  const saved = await svc.updateKey(user, "website", created.name, {
    version: 1,
    translations: { fr: "Bonjour {name}" },
  });
  assert.equal(saved.translations.en, "Hello {name}");
  assert.equal(saved.translations.fr, "Bonjour {name}");
  assert.equal(saved.version, 2);
  for (const change of [
    { translations: { en: "Changed" } },
    { translations: {}, description: "Changed" },
    { translations: {}, namespace: "changed" },
    { translations: {}, tags: ["changed"] },
  ])
    await assert.rejects(
      svc.updateKey(user, "website", created.name, { version: 2, ...change }),
      denied(403),
    );
  await assert.rejects(
    svc.updateProject(user, "website", { ...project, version: 1 }),
    denied(403),
  );
  await assert.rejects(
    svc.createToken(user, "website", { name: "CI" }),
    denied(403),
  );
  await assert.rejects(
    svc.deleteKey(user, "website", created.name, 2),
    denied(403),
  );
});
test("conditional writes prevent duplicate keys and lost concurrent edits", async () => {
  const { svc } = await fixture();
  await svc.createKey(manager, "website", key);
  await assert.rejects(svc.createKey(manager, "website", key), Conflict);
  const updates = await Promise.allSettled(
    ["Bonjour {name}", "Salut {name}"].map((fr) =>
      svc.updateKey(user, "website", key.name, {
        version: 1,
        translations: { fr },
      }),
    ),
  );
  assert.equal(updates.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    updates.filter(
      (r) => r.status === "rejected" && r.reason instanceof Conflict,
    ).length,
    1,
  );
  await assert.rejects(
    svc.deleteKey(manager, "website", key.name, 1),
    Conflict,
  );
  await svc.deleteKey(manager, "website", key.name, 2);
  assert.deepEqual(await svc.keys(manager, "website"), []);
});
test("language configuration validates canonical locale codes and preserves existing translations", async () => {
  const { svc } = await fixture();
  await assert.rejects(
    svc.createProject(admin, {
      ...project,
      id: "bad",
      languages: [{ code: "../../x", name: "Invalid" }],
    }),
    ZodError,
  );
  await assert.rejects(
    svc.createKey(manager, "website", {
      ...key,
      translations: { de: "Hallo" },
    }),
    denied(400),
  );
  await assert.rejects(
    svc.updateProject(manager, "website", {
      ...project,
      version: 1,
      languages: [project.languages[0]],
    }),
    denied(400),
  );
  await assert.rejects(
    svc.updateProject(manager, "website", {
      ...project,
      version: 1,
      sourceLanguage: "fr",
    }),
    denied(400),
  );
  const next = await svc.updateProject(manager, "website", {
    ...project,
    version: 1,
    languages: [
      ...project.languages,
      { code: "pt-BR", name: "Portuguese (Brazil)" },
    ],
  });
  assert.equal(next.languages.length, 3);
  assert.equal(next.version, 2);
});
test("exports preserve interpolation and whitespace, support fallback and reject unknown locales", async () => {
  const { svc } = await fixture();
  await svc.createKey(manager, "website", key);
  await svc.createKey(manager, "website", {
    name: "action",
    translations: { en: " Save ", fr: " Sauver " },
  });
  const flat = await svc.export(user, "website", ["fr"], "flat", false);
  assert.equal(
    (flat.translations.fr as Record<string, string>)["home.title"],
    "",
  );
  assert.equal(
    (flat.translations.fr as Record<string, string>).action,
    " Sauver ",
  );
  const nested = await svc.export(user, "website", ["fr"], "nested", true);
  assert.equal(
    (nested.translations.fr as { home: { title: string } }).home.title,
    "Hello {name}",
  );
  await assert.rejects(
    svc.export(user, "website", ["de"], "flat", false),
    denied(400),
  );
  await assert.rejects(
    svc.export(user, "website", [], "invalid", false),
    denied(400),
  );
});
test("prototype keys and nested JSON collisions are rejected safely", async () => {
  const { svc } = await fixture();
  for (const name of ["__proto__.x", "a.constructor.b", "a..b", "prototype.x"])
    await assert.rejects(
      svc.createKey(manager, "website", { ...key, name }),
      ZodError,
    );
  await svc.createKey(manager, "website", { ...key, name: "a" });
  await svc.createKey(manager, "website", { ...key, name: "a.b" });
  await assert.rejects(
    svc.export(user, "website", ["en"], "nested", false),
    denied(422),
  );
  const flat = await svc.export(user, "website", ["en"], "flat", false);
  assert.equal(Object.keys(flat.translations.en as object).length, 2);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});
test("export tokens are stored as hashes, project-scoped, expiring, and immediately revocable", async () => {
  const store = await getStore();
  const svc = new KieliService(store);
  await svc.createProject(admin, project);
  const token = await svc.createToken(manager, "website", {
    name: "CI",
    expiresInDays: 1,
  });
  const hash = hashToken(token.secret);
  const stored = await store.get<Token>("PROJECT#website", `TOKEN#${hash}`);
  assert.equal(stored?.hash, hash);
  assert.equal(JSON.stringify(stored).includes(token.secret), false);
  assert.equal("secret" in (await svc.tokens(manager, "website"))[0]!, false);
  const request = new Request(
    "http://localhost:4321/api/projects/website/export",
    { headers: { Authorization: `Bearer ${token.secret}` } },
  );
  const cookies = {} as AstroCookies;
  const identity = await authenticate(request, cookies);
  assert.equal(identity?.tokenProject, "website");
  assert.equal(identity?.admin, false);
  assert.throws(() => authorize(identity!, "other"), denied(403));
  await svc.revokeToken(manager, "website", hash);
  await assert.rejects(authenticate(request, cookies), denied(401));
  const expired = {
    ...stored!,
    version: 1,
    expiresAt: "2000-01-01T00:00:00.000Z",
  };
  await store.put("PROJECT#website", `TOKEN#${hash}`, expired);
  await assert.rejects(authenticate(request, cookies), denied(401));
});
test("browser writes require a matching origin, and demo mode is forbidden in production", () => {
  checkOrigin(
    new Request("http://localhost:4321/api/projects", {
      headers: { Origin: "http://localhost:4321" },
    }),
  );
  assert.throws(
    () =>
      checkOrigin(
        new Request("http://localhost:4321/api/projects", {
          headers: { Origin: "https://attacker.example" },
        }),
      ),
    denied(403),
  );
  assert.throws(
    () => checkOrigin(new Request("http://localhost:4321/api/projects")),
    denied(403),
  );
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    assert.throws(config, /forbidden in production/);
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});
test("OIDC login state uses authenticated encryption and rejects malformed keys", async () => {
  const sealed = await seal({ identity: admin }, 3600, "session");
  assert.equal(sealed.split(".").length, 5);
  assert.equal(sealed.includes(admin.email), false);
  const previous = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = "short";
  try {
    await assert.rejects(seal({}, 3600, "session"), /32 random bytes/);
  } finally {
    process.env.SESSION_SECRET = previous;
  }
});
