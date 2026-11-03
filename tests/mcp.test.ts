import { Glossary } from "../src/server/glossary";
import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ZodError } from "zod";
import type { Identity } from "../src/shared";
import { HttpError, hashToken, authenticate } from "../src/server/auth";
import { SsoDirectory } from "../src/server/sso-directory";
import { McpCredentials } from "../src/server/mcp-credentials";
import { handleMcp } from "../src/server/mcp";
import { KieliService } from "../src/server/service";
import { Conflict, sqliteStore } from "../src/server/store";
import type { AstroCookies } from "astro";

process.env.AUTH_MODE = "demo";
process.env.APP_ORIGIN = "http://localhost:4321";
const admin: Identity = {
  sub: "admin",
  name: "Admin",
  email: "admin@example.com",
  admin: true,
  projects: {},
};
const request = (
  secret = "",
  body: unknown = { jsonrpc: "2.0", id: 1, method: "tools/list" },
  headers: Record<string, string> = {},
) =>
  new Request("http://localhost:4321/mcp", {
    method: "POST",
    headers: {
      host: "localhost:4321",
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(secret ? { authorization: `Bearer ${secret}` } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });
const denied = (status: number) => (error: unknown) =>
  error instanceof HttpError && error.status === status;
async function fixture(overwrite = false) {
  const store = await sqliteStore(":memory:");
  const svc = new KieliService(store),
    credentials = new McpCredentials(store);
  await svc.createProject(admin, {
    id: "website",
    name: "Website",
    sourceLanguage: "en",
    languages: [
      { code: "en", name: "English" },
      { code: "fr", name: "French" },
      { code: "nl", name: "Dutch" },
    ],
  });
  await svc.createKey(admin, "website", {
    name: "home.title",
    description: "A warm welcome",
    translations: {
      en: "Hello {name}",
      fr: "",
      nl: "Private Dutch copy {name}",
    },
  });
  await svc.createKey(admin, "website", {
    name: "home.cta",
    translations: { en: "Start", fr: "Commencer" },
  });
  const issued = await credentials.create(admin, "website", {
    name: "Claude",
    languages: ["fr"],
    allowOverwrite: overwrite,
  });
  const identity = await credentials.authenticate(request(issued.secret));
  return { store, svc, credentials, issued, identity };
}
const update = (
  key = "home.title",
  expectedVersion = 1,
  translations: Record<string, string> = { fr: "Bonjour {name}" },
) => ({ key, expectedVersion, translations });

test("MCP credentials are hashed, project scoped, and separate from export credentials", async () => {
  const f = await fixture();
  assert.equal(f.issued.credential.id, hashToken(f.issued.secret));
  assert.ok(
    !JSON.stringify(
      await f.store.list("PROJECT#website", "MCP_TOKEN#"),
    ).includes(f.issued.secret),
  );
  assert.equal(f.identity.admin, false);
  assert.deepEqual(f.identity.projects, { website: "user" });
  assert.deepEqual(f.identity.mcp?.languages, ["fr"]);
  await assert.rejects(
    authenticate(request(f.issued.secret), {} as AstroCookies),
    denied(401),
  );
  await assert.rejects(
    f.credentials.authenticate(request("kieli_website." + "a".repeat(64))),
    denied(401),
  );
  const listed = await f.credentials.list(admin, "website");
  assert.ok(listed[0]?.lastUsedAt);
  assert.ok(!("createdBy" in listed[0]!));
});
test("only managers may issue credentials and scopes contain unique configured targets", async () => {
  const f = await fixture();
  const user = {
    ...admin,
    admin: false,
    projects: { website: "user" as const },
  };
  await assert.rejects(
    f.credentials.create(user, "website", { name: "no", languages: ["fr"] }),
    denied(403),
  );
  await assert.rejects(f.credentials.list(user, "website"), denied(403));
  await assert.rejects(
    f.credentials.revoke(user, "website", f.issued.credential.id),
    denied(403),
  );
  for (const languages of [["en"], ["de"], ["fr", "fr"]])
    await assert.rejects(
      f.credentials.create(admin, "website", { name: "no", languages }),
      denied(400),
    );
  await assert.rejects(
    f.credentials.create(admin, "website", { name: "no", languages: [] }),
    ZodError,
  );
  await assert.rejects(
    f.credentials.create(admin, "website", {
      name: "no",
      languages: ["fr"],
      expiresInDays: 31,
    }),
    ZodError,
  );
});
test("translation batches preserve source/context, update counters, and audit without copy or secrets", async () => {
  const f = await fixture();
  assert.deepEqual(
    await f.svc.setMcpTranslations(f.identity, "website", {
      updates: [update()],
    }),
    { saved: [{ key: "home.title", version: 2 }] },
  );
  const key = await f.svc.key(admin, "website", "home.title");
  assert.equal(key.translations.en, "Hello {name}");
  assert.equal(key.translations.nl, "Private Dutch copy {name}");
  assert.equal(key.description, "A warm welcome");
  assert.equal(key.updatedBy, "Claude · Claude");
  assert.equal((await f.svc.summary(admin, "website")).byLanguage.fr, 2);
  const events = JSON.stringify(await f.store.list("AUTH_AUDIT", ""));
  assert.ok(events.includes("mcp.translations_saved"));
  assert.ok(events.includes("home.title"));
  assert.ok(!events.includes("Bonjour"));
  assert.ok(!events.includes(f.issued.secret));
});
test("MCP refuses source edits, other locales, blank text, unknown keys, metadata, and duplicates", async () => {
  const f = await fixture();
  const forbiddenTranslations: Record<string, string>[] = [
    { en: "Hello {name}" },
    { nl: "Hallo" },
    { de: "Hallo" },
  ];
  for (const translations of forbiddenTranslations)
    await assert.rejects(
      f.svc.setMcpTranslations(f.identity, "website", {
        updates: [update("home.title", 1, translations)],
      }),
      (error) => error instanceof HttpError,
    );
  await assert.rejects(
    f.svc.setMcpTranslations(f.identity, "website", {
      updates: [update("home.title", 1, { fr: "  " })],
    }),
    denied(400),
  );
  await assert.rejects(
    f.svc.setMcpTranslations(f.identity, "website", {
      updates: [update("unknown")],
    }),
    denied(404),
  );
  await assert.rejects(
    f.svc.setMcpTranslations(f.identity, "website", {
      updates: [{ ...update(), description: "changed" }],
    }),
    ZodError,
  );
  await assert.rejects(
    f.svc.setMcpTranslations(f.identity, "website", {
      updates: [update(), update()],
    }),
    denied(400),
  );
  await assert.rejects(
    f.svc.updateKey(f.identity, "website", "home.title", {
      version: 1,
      translations: { fr: "Bonjour" },
    }),
    denied(403),
  );
  await assert.rejects(
    f.svc.createKey(f.identity, "website", { name: "new", translations: {} }),
    denied(403),
  );
  await assert.rejects(
    f.svc.setMcpTranslations(f.identity, "other", { updates: [update()] }),
    denied(403),
  );
});
test("overwriting needs both credential permission and explicit per-call intent", async () => {
  const f = await fixture();
  await assert.rejects(
    f.svc.setMcpTranslations(f.identity, "website", {
      updates: [update("home.cta", 1, { fr: "Démarrer" })],
    }),
    denied(409),
  );
  await assert.rejects(
    f.svc.setMcpTranslations(f.identity, "website", {
      updates: [update("home.cta", 1, { fr: "Démarrer" })],
      overwriteExisting: true,
    }),
    denied(403),
  );
  const enabled = await fixture(true);
  await assert.rejects(
    enabled.svc.setMcpTranslations(enabled.identity, "website", {
      updates: [update("home.cta", 1, { fr: "Démarrer" })],
    }),
    denied(409),
  );
  await enabled.svc.setMcpTranslations(enabled.identity, "website", {
    updates: [update("home.cta", 1, { fr: "Démarrer" })],
    overwriteExisting: true,
  });
});
test("stale versions and any invalid member roll back the entire batch", async () => {
  const f = await fixture(true);
  await assert.rejects(
    f.svc.setMcpTranslations(f.identity, "website", {
      updates: [update(), update("home.cta", 99, { fr: "Démarrer" })],
      overwriteExisting: true,
    }),
    Conflict,
  );
  assert.equal((await f.svc.key(admin, "website", "home.title")).version, 1);
  await f.svc.setMcpTranslations(f.identity, "website", {
    updates: [update(), update("home.cta", 1, { fr: "Démarrer" })],
    overwriteExisting: true,
  });
  assert.equal((await f.svc.key(admin, "website", "home.cta")).version, 2);
  await assert.rejects(
    f.svc.setMcpTranslations(f.identity, "website", { updates: [update()] }),
    Conflict,
  );
});
test("expiry, revocation and mode changes are checked on every MCP request", async () => {
  const f = await fixture();
  await f.credentials.revoke(admin, "website", f.issued.credential.id);
  await assert.rejects(
    f.credentials.authenticate(request(f.issued.secret)),
    denied(401),
  );
  const other = await f.credentials.create(admin, "website", {
    name: "Expired",
    languages: ["fr"],
  });
  const pk = "PROJECT#website",
    sk = `MCP_TOKEN#${other.credential.id}`;
  const row = await f.store.get<any>(pk, sk);
  await f.store.put(
    pk,
    sk,
    { ...row, version: row.version + 1, expiresAt: new Date(0).toISOString() },
    row.version,
  );
  await assert.rejects(
    f.credentials.authenticate(request(other.secret)),
    denied(401),
  );
  const mode = await f.credentials.create(admin, "website", {
    name: "Mode",
    languages: ["fr"],
  });
  process.env.AUTH_MODE = "local";
  try {
    await assert.rejects(
      f.credentials.authenticate(request(mode.secret)),
      denied(401),
    );
  } finally {
    process.env.AUTH_MODE = "demo";
  }
});
test("MCP boundary rejects cookies/demo fallback, bad origins/hosts, oversized and non-JSON bodies", async () => {
  const f = await fixture();
  assert.equal(
    (
      await handleMcp(
        request("", undefined, { cookie: "kieli_session=" + "a".repeat(64) }),
        f.store,
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await handleMcp(
        request(f.issued.secret, {}, { origin: "https://evil.example" }),
        f.store,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await handleMcp(
        request(f.issued.secret, {}, { host: "evil.example" }),
        f.store,
      )
    ).status,
    403,
  );
  assert.equal(
    (await handleMcp(request(f.issued.secret, {}, { origin: "null" }), f.store))
      .status,
    403,
  );
  assert.equal(
    (
      await handleMcp(
        request(f.issued.secret, {}, { "content-type": "text/plain" }),
        f.store,
      )
    ).status,
    415,
  );
  assert.equal(
    (
      await handleMcp(
        request(f.issued.secret, { text: "x".repeat(262145) }),
        f.store,
      )
    ).status,
    413,
  );
});
test("official MCP client discovers five scoped tools, reads scoped context and saves translations", async () => {
  const f = await fixture();
  await new Glossary(f.store).save(admin, "website", {
    source: "Hello",
    translations: { fr: "Bonjour", nl: "Unpermitted glossary copy" },
    notes: "A greeting.",
  });

  const client = new Client({ name: "test-client", version: "1" });
  const transport = new StreamableHTTPClientTransport(
    new URL("http://localhost:4321/mcp"),
    {
      requestInit: { headers: { authorization: `Bearer ${f.issued.secret}` } },
      fetch: async (input, init) => {
        const req = new Request(input, init);
        req.headers.set("host", "localhost:4321");
        return handleMcp(req, f.store);
      },
    },
  );
  try {
    await client.connect(transport);
    assert.deepEqual(
      (await client.listTools()).tools.map((tool) => tool.name).sort(),
      [
        "get_key",
        "get_project",
        "list_glossary",
        "list_keys",
        "set_translations",
      ],
    );
    const call = async (name: string, args = {}) => {
      const response = await client.callTool({ name, arguments: args });
      return {
        data: JSON.parse((response.content as { text: string }[])[0]!.text),
        error: response.isError,
      };
    };
    const project = await call("get_project");
    assert.deepEqual(project.data.targetLanguages, [
      {
        code: "fr",
        name: "French",
        pluralForms: ["one", "many", "other"],
        ordinalForms: ["one", "other"],
      },
    ]);
    const page = await call("list_keys", { limit: 1 });
    assert.equal(page.data.items[0].key, "home.title");
    assert.ok(!JSON.stringify(page.data).includes("Private Dutch"));
    const key = await call("get_key", { key: "home.title" });
    assert.deepEqual(key.data.translations, { fr: "" });
    assert.equal(key.data.source, "Hello {name}");
    assert.deepEqual(key.data.glossary.items[0].translations, {
      fr: "Bonjour",
    });
    const terms = await call("list_glossary", { text: "Hello there" });
    assert.equal(terms.data.items[0].source, "Hello");
    assert.ok(!JSON.stringify(terms.data).includes("Unpermitted"));
    assert.equal((await call("list_glossary", { language: "nl" })).error, true);
    assert.equal(
      (
        await client.callTool({
          name: "list_glossary",
          arguments: { project: "other" },
        })
      ).isError,
      true,
    );

    assert.equal((await call("list_keys", { language: "nl" })).error, true);
    assert.equal(
      (await call("set_translations", { updates: [update()] })).error,
      undefined,
    );
    assert.equal(
      (await call("set_translations", { updates: [update()] })).data.status,
      409,
    );
    await f.credentials.revoke(admin, "website", f.issued.credential.id);
    await assert.rejects(client.listTools());
  } finally {
    await client.close();
  }
});
test("local creator disablement, auth epoch and project membership are live authorization checks", async () => {
  const f = await fixture();
  process.env.AUTH_MODE = "local";
  try {
    const user = {
      id: "owner",
      name: "Owner",
      email: "owner@example.com",
      status: "active",
      workspaceRole: "member",
      projects: { website: "manager" },
      version: 1,
      authVersion: 1,
      createdAt: "",
      updatedAt: "",
    };
    await f.store.put("USERS", "USER#owner", user);
    const identity: Identity = {
      ...admin,
      sub: "local:owner",
      provider: "local",
      admin: false,
      projects: { website: "manager" },
    };
    const token = await f.credentials.create(identity, "website", {
      name: "Local",
      languages: ["fr"],
    });
    await f.credentials.authenticate(request(token.secret));
    for (const delta of [
      { status: "disabled" },
      { authVersion: 2 },
      { projects: { website: "user" } },
    ]) {
      const current = await f.store.get<any>("USERS", "USER#owner");
      await f.store.put(
        "USERS",
        "USER#owner",
        { ...user, ...delta, version: current.version + 1 },
        current.version,
      );
      await assert.rejects(
        f.credentials.authenticate(request(token.secret)),
        denied(401),
      );
    }
  } finally {
    process.env.AUTH_MODE = "demo";
  }
});
test("SSO credentials cannot outlive their sign-in snapshot", async () => {
  const f = await fixture();
  const previousIssuer = process.env.SAML_IDP_ISSUER;
  process.env.SAML_IDP_ISSUER = "https://idp.example.com";
  process.env.AUTH_MODE = "saml";
  process.env.APP_ORIGIN = "https://copy.example.com";
  try {
    const now = Math.floor(Date.now() / 1000);
    const identity: Identity = {
      ...(
        await new SsoDirectory(f.store).login({
          ...admin,
          provider: "saml",
          authTime: now,
        })
      ).identity,
      authTime: now,
      sessionExpiresAt: now + 120,
    };
    const issued = await f.credentials.create(identity, "website", {
      name: "SSO",
      languages: ["fr"],
      expiresInDays: 30,
    });
    assert.equal(Date.parse(issued.credential.expiresAt), (now + 120) * 1000);
    await assert.rejects(
      f.credentials.create(
        { ...identity, sessionExpiresAt: now - 1 },
        "website",
        { name: "Old", languages: ["fr"] },
      ),
      denied(401),
    );
  } finally {
    if (previousIssuer === undefined) delete process.env.SAML_IDP_ISSUER;
    else process.env.SAML_IDP_ISSUER = previousIssuer;
    process.env.AUTH_MODE = "demo";
    process.env.APP_ORIGIN = "http://localhost:4321";
  }
});
test("valid credentials share a bounded request rate limit", async () => {
  const f = await fixture();
  for (let i = 1; i < 120; i++)
    await f.credentials.authenticate(request(f.issued.secret));
  await assert.rejects(
    f.credentials.authenticate(request(f.issued.secret)),
    denied(429),
  );
});

test("racing batches commit one complete winner, with matching counters and audit", async () => {
  const f = await fixture(true);
  const settled = await Promise.allSettled([
    f.svc.setMcpTranslations(f.identity, "website", {
      updates: [
        update("home.title", 1, { fr: "A title {name}" }),
        update("home.cta", 1, { fr: "A button" }),
      ],
      overwriteExisting: true,
    }),
    f.svc.setMcpTranslations(f.identity, "website", {
      updates: [
        update("home.title", 1, { fr: "B title {name}" }),
        update("home.cta", 1, { fr: "B button" }),
      ],
      overwriteExisting: true,
    }),
  ]);
  assert.equal(settled.filter((item) => item.status === "fulfilled").length, 1);
  const title = await f.svc.key(admin, "website", "home.title");
  const button = await f.svc.key(admin, "website", "home.cta");
  assert.equal(title.version, 2);
  assert.equal(button.version, 2);
  assert.equal(title.translations.fr?.[0], button.translations.fr?.[0]);
  assert.equal((await f.svc.summary(admin, "website")).byLanguage.fr, 2);
  const events = await f.store.list<{ action: string }>("AUTH_AUDIT", "");
  assert.equal(
    events.filter((event) => event.action === "mcp.translations_saved").length,
    1,
  );
});
