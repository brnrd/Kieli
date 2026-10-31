import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Glossary } from "../src/server/glossary";
import { KeyloService } from "../src/server/service";
import { sqliteStore, Conflict } from "../src/server/store";
import {
  matchingTermIds,
  glossaryFileSchema,
  type GlossaryTerm,
} from "../src/glossary";
import type { Identity } from "../src/shared";
const admin: Identity = {
  sub: "admin",
  name: "Admin",
  email: "admin@example.com",
  admin: true,
  projects: {},
};
const member: Identity = {
  ...admin,
  sub: "member",
  admin: false,
  projects: { web: "user" },
};
const manager: Identity = {
  ...member,
  sub: "manager",
  projects: { web: "manager" },
};
const mcp: Identity = {
  ...member,
  mcp: {
    projectId: "web",
    credentialId: "connection",
    languages: ["fr"],
    allowOverwrite: false,
  },
};
const term = {
  source: "workspace",
  translations: {
    fr: "espace de travail",
    nl: "werkruimte",
    ar: "مساحة العمل",
  },
  notes: "A place for one team.",
  caseSensitive: false,
};
async function fixture() {
  const store = await sqliteStore(":memory:"),
    service = new KeyloService(store);
  await service.createProject(admin, {
    id: "web",
    name: "Website",
    sourceLanguage: "en",
    languages: [
      { code: "en", name: "English" },
      { code: "fr", name: "French" },
      { code: "nl", name: "Dutch" },
      { code: "ar", name: "Arabic" },
    ],
  });
  await service.createProject(admin, {
    id: "other",
    name: "Other",
    sourceLanguage: "en",
    languages: [
      { code: "en", name: "English" },
      { code: "fr", name: "French" },
    ],
  });
  return { store, service, glossary: new Glossary(store) };
}
test("glossary changes are manager-only, versioned, audited without copy, and project-scoped", async () => {
  const { glossary, store } = await fixture();
  for (const identity of [
    member,
    { ...member, projects: {} },
    { ...admin, tokenProject: "web" },
    { ...admin, sync: { projectId: "web", credentialId: "x", prefixes: [] } },
    mcp,
  ])
    await assert.rejects(glossary.save(identity, "web", term));
  const created = await glossary.save(manager, "web", term);
  assert.equal(created.version, 1);
  const edited = await glossary.save(
    manager,
    "web",
    { ...term, notes: "Private wording guidance.", version: 1 },
    created.id,
  );
  assert.equal(edited.version, 2);
  await assert.rejects(
    glossary.save(manager, "web", { ...term, version: 1 }, created.id),
    Conflict,
  );
  await assert.rejects(
    glossary.list({ ...member, projects: {} }, "web", {}),
    /access/,
  );
  assert.equal(
    (await glossary.list(member, "web", {})).items[0]!.notes,
    "Private wording guidance.",
  );
  assert.equal((await glossary.list(admin, "other", {})).total, 0);
  await assert.rejects(glossary.remove(member, "web", created.id, 2));
  await glossary.remove(manager, "web", created.id, 2);
  assert.equal((await glossary.list(admin, "web", {})).total, 0);
  const audit = await store.list<any>("AUTH_AUDIT", "");
  assert.deepEqual(audit.map((event) => event.action).sort(), [
    "glossary.created",
    "glossary.deleted",
    "glossary.updated",
  ]);
  assert.ok(
    audit.every(
      (event) =>
        event.project === "web" &&
        event.actor === manager.sub &&
        event.outcome === "success" &&
        event.at,
    ),
  );
  assert.ok(
    !JSON.stringify(audit).includes("Private wording") &&
      !JSON.stringify(audit).includes("werkruimte"),
  );
});
test("duplicate source terms are normalized and concurrent creates have one atomic winner", async () => {
  const { glossary, store } = await fixture();
  const results = await Promise.allSettled(
    ["Workspace", "  ＷＯＲＫＳＰＡＣＥ  "].map((source) =>
      glossary.save(manager, "web", { ...term, source }),
    ),
  );
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal((await store.get<any>("PROJECT#web", "GLOSSARY_META")).count, 1);
  const created = (await glossary.list(admin, "web", {})).items[0]!;
  const updates = await Promise.allSettled(
    ["one", "two"].map((notes) =>
      glossary.save(
        manager,
        "web",
        { ...term, version: created.version, notes },
        created.id,
      ),
    ),
  );
  assert.equal(
    updates.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const latest = (await glossary.list(admin, "web", {})).items[0]!;
  assert.equal(latest.version, 2);
  await assert.rejects(glossary.remove(manager, "web", latest.id, 1), Conflict);
});
test("imports are add-only, atomic per batch, retry-safe and bound to their actor and content", async () => {
  const { glossary } = await fixture();
  await glossary.save(manager, "web", term);
  const batch = {
    batchId: randomUUID(),
    sourceLanguage: "en",
    terms: [
      { ...term, translations: { fr: "Do not replace" } },
      { source: "billing", translations: { fr: "facturation" } },
    ],
  };
  assert.deepEqual(await glossary.import(manager, "web", batch), {
    added: 1,
    skipped: 1,
    replayed: false,
  });
  assert.deepEqual(
    await glossary.import(manager, "web", JSON.parse(JSON.stringify(batch))),
    { added: 1, skipped: 1, replayed: true },
  );
  assert.equal(
    (await glossary.list(admin, "web", { query: "workspace" })).items[0]!
      .translations.fr,
    term.translations.fr,
  );
  await assert.rejects(
    glossary.import(admin, "web", batch),
    /cannot be reused/,
  );
  await assert.rejects(
    glossary.import(manager, "web", { ...batch, terms: [{ source: "other" }] }),
    /cannot be reused/,
  );
  await assert.rejects(
    glossary.import(manager, "web", {
      batchId: randomUUID(),
      sourceLanguage: "en",
      terms: [
        { source: "valid" },
        { source: "invalid", translations: { xx: "unknown" } },
      ],
    }),
    /configured target/,
  );
  assert.equal((await glossary.list(admin, "web", {})).total, 2);
  await assert.rejects(
    glossary.import(manager, "web", {
      batchId: randomUUID(),
      sourceLanguage: "fr",
      terms: [{ source: "valid" }],
    }),
    /source language/,
  );
  await assert.rejects(
    glossary.import(manager, "web", {
      batchId: randomUUID(),
      sourceLanguage: "en",
      terms: [{ source: "same" }, { source: "SAME" }],
    }),
    /Duplicate/,
  );
  const file = await glossary.export(member, "web");
  assert.deepEqual(glossaryFileSchema.parse(file), file);
  assert.ok(
    file.terms.every((item) => !("id" in item) && !("version" in item)),
  );
  await assert.rejects(glossary.export(mcp, "web"), /scoped/);
});
test("MCP projections and searches exclude ungranted translations; caches invalidate after writes", async () => {
  const { glossary } = await fixture();
  const created = await glossary.save(manager, "web", {
    ...term,
    translations: { fr: "espace", nl: "ungranted-needle" },
  });
  const visible = await glossary.list(mcp, "web", {});
  assert.deepEqual(visible.items[0]!.translations, { fr: "espace" });
  assert.equal(
    (await glossary.list(mcp, "web", { query: "ungranted-needle" })).total,
    0,
  );
  await assert.rejects(glossary.list(mcp, "web", { language: "nl" }), /scope/);
  await assert.rejects(glossary.list({ ...admin, mcp: mcp.mcp }, "other", {}));
  await glossary.save(
    manager,
    "web",
    {
      ...term,
      version: created.version,
      translations: { fr: "nouvel espace" },
    },
    created.id,
  );
  assert.equal(
    (await glossary.list(mcp, "web", {})).items[0]!.translations.fr,
    "nouvel espace",
  );
});
test("matching uses literal Unicode words, phrases and optional exact case, without executing term text", () => {
  const make = (source: string, caseSensitive = false): GlossaryTerm => ({
    id: source,
    source,
    translations: {},
    notes: "",
    caseSensitive,
    version: 1,
    createdAt: "",
    updatedAt: "",
    updatedBy: "",
  });
  const terms = [
    make("workspace"),
    make("New York"),
    make("API", true),
    make("Café"),
    make(".*"),
  ];
  assert.deepEqual(
    [
      ...matchingTermIds(
        "WORKSPACE in New   York: API cafe\u0301",
        terms,
        "en",
      ),
    ],
    ["workspace", "New York", "API", "Café"],
  );
  assert.equal(
    matchingTermIds("workspaces api cafeteria", terms, "en").size,
    0,
  );
  assert.equal(matchingTermIds("account", [make(".*")], "en").size, 0);
  assert.ok(matchingTermIds("您的账户设置", [make("账户")], "zh").has("账户"));
});
test("glossary search and cursor pagination are bounded and cannot cross projects", async () => {
  const { glossary } = await fixture();
  await glossary.import(manager, "web", {
    batchId: randomUUID(),
    sourceLanguage: "en",
    terms: Array.from({ length: 20 }, (_, i) => ({
      source: `Term ${String(i).padStart(2, "0")}`,
      notes: "Find me",
    })),
  });
  const first = await glossary.list(member, "web", {
    limit: 7,
    query: "find me",
  });
  const second = await glossary.list(member, "web", {
    limit: 7,
    query: "find me",
    cursor: first.nextCursor,
  });
  assert.equal(first.items.length, 7);
  assert.equal(second.items[0]!.source, "Term 07");
  await assert.rejects(
    glossary.list(admin, "other", { cursor: first.nextCursor }),
    /cursor/,
  );
  await assert.rejects(glossary.list(member, "web", { limit: 1000 }));
});
test("quota guards prevent concurrent writes from exceeding the project limit", async () => {
  const { glossary, store } = await fixture();
  for (let i = 0; i < 999; i += 80)
    await store.transact(
      Array.from({ length: Math.min(80, 999 - i) }, (_, j) => {
        const item: GlossaryTerm = {
          id: randomUUID(),
          source: `Seed ${i + j}`,
          translations: {},
          notes: "",
          caseSensitive: false,
          version: 1,
          createdAt: "",
          updatedAt: "",
          updatedBy: "fixture",
        };
        return {
          pk: "PROJECT#web",
          sk: `GLOSSARY_TERM#${item.id}`,
          value: { ...item },
        };
      }),
    );
  await store.put("PROJECT#web", "GLOSSARY_META", { version: 1, count: 999 });
  const results = await Promise.allSettled(
    ["Last one", "Last two"].map((source) =>
      glossary.save(manager, "web", { source }),
    ),
  );
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    (await store.get<any>("PROJECT#web", "GLOSSARY_META")).count,
    1000,
  );
  assert.equal((await glossary.list(member, "web", {})).total, 1000);
});

test("partial edits preserve other fields and translations retained outside a restored language set", async () => {
  const { glossary, service, store } = await fixture();
  const created = await glossary.save(manager, "web", term);
  const project = await service.project(admin, "web");
  await store.put(
    "WORKSPACE",
    "PROJECT#web",
    {
      ...project,
      version: project.version + 1,
      languages: project.languages.filter((locale) => locale.code !== "nl"),
    },
    project.version,
  );
  const edited = await glossary.save(
    manager,
    "web",
    { version: 1, notes: "Changed note" },
    created.id,
  );
  assert.equal(edited.translations.fr, term.translations.fr);
  assert.equal(edited.translations.nl, term.translations.nl);
  assert.equal(
    (await glossary.list(member, "web", {})).items[0]!.translations.nl,
    undefined,
  );
  assert.equal(
    (await glossary.export(member, "web")).terms[0]!.translations.nl,
    term.translations.nl,
  );
});
