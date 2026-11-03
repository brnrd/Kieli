import { sameTranslation } from "../src/components/editor-draft";
import test from "node:test";
import assert from "node:assert/strict";
import { KieliService } from "../src/server/service";
import { sqliteStore } from "../src/server/store";
import { parseEditorPreferences } from "../src/components/editor-preferences";
import type { Identity } from "../src/shared";
const admin: Identity = {
  sub: "admin",
  name: "Admin",
  email: "admin@example.com",
  admin: true,
  projects: {},
};
async function fixture(advanced = false) {
  const store = await sqliteStore(":memory:"),
    svc = new KieliService(store);
  await svc.createProject(admin, {
    id: "web",
    name: "Web",
    sourceLanguage: "en",
    languages: [
      { code: "en", name: "English" },
      { code: "fr", name: "French" },
      { code: "ar", name: "Arabic" },
    ],
  });
  for (let i = 0; i < 61; i++)
    await svc.createKey(admin, "web", {
      name: `key.${String(i).padStart(3, "0")}`,
      namespace: i % 2 ? "odd" : "even",
      description: i % 3 ? "" : "campaign",
      translations: {
        en: `Text ${i}`,
        ...(i % 4 ? { fr: `Texte ${i}` } : {}),
        ar: `نص ${i}`,
      },
    });
  if (advanced)
    await svc.createKey(admin, "web", {
      name: "linked",
      translations: {
        en: "[%key:key.001%]",
        fr: "[%key:key.001%]",
        ar: "[%key:key.001%]",
      },
    });
  return { svc, store };
}
for (const advanced of [false, true])
  test(`navigation crosses cursor pages in both directions, retaining locale/search/namespace/status (${advanced ? "linked" : "ordinary"})`, async () => {
    const { svc } = await fixture(advanced);
    const first = await svc.keyPage(admin, "web", { limit: 25 });
    const second = await svc.keyPage(admin, "web", {
      limit: 25,
      cursor: first.nextCursor,
    });
    assert.equal(second.items[0]!.name, "key.025");
    assert.equal(
      (
        await svc.keyNeighbor(admin, "web", first.items.at(-1)!.name, {
          direction: "next",
        })
      ).key!.name,
      second.items[0]!.name,
    );
    assert.equal(
      (
        await svc.keyNeighbor(admin, "web", "key.025", {
          direction: "previous",
        })
      ).key!.name,
      "key.024",
    );
    const filters = {
      query: "campaign",
      namespace: "even",
      language: "fr",
      status: "missing",
    };
    assert.equal(
      (
        await svc.keyNeighbor(admin, "web", "key.024", {
          ...filters,
          direction: "next",
        })
      ).key!.name,
      "key.036",
    );
    assert.equal(
      (
        await svc.keyNeighbor(admin, "web", "key.036", {
          ...filters,
          direction: "previous",
        })
      ).key!.name,
      "key.024",
    );
    assert.equal(
      (
        await svc.keyNeighbor(admin, "web", "key.024", {
          ...filters,
          language: "ar",
          direction: "next",
        })
      ).key,
      null,
    );
    assert.equal(
      (
        await svc.keyNeighbor(admin, "web", "key.000", {
          direction: "previous",
        })
      ).key,
      null,
    );
  });
test("saved keys can leave the result and deleted anchors still navigate without stale array indexes", async () => {
  const { svc } = await fixture();
  const filtered = await svc.keyPage(admin, "web", {
    limit: 25,
    status: "missing",
    languages: ["fr"],
  });
  assert.equal(filtered.items[0]!.name, "key.000");
  await svc.updateKey(admin, "web", "key.000", {
    version: 1,
    translations: { fr: "Texte 0" },
  });
  assert.equal(
    (
      await svc.keyNeighbor(admin, "web", "key.000", {
        direction: "next",
        language: "fr",
        status: "missing",
      })
    ).key!.name,
    "key.004",
  );
  await svc.deleteKey(admin, "web", "key.004", 1);
  assert.equal(
    (
      await svc.keyNeighbor(admin, "web", "key.004", {
        direction: "next",
        language: "fr",
        status: "missing",
      })
    ).key!.name,
    "key.008",
  );
  await svc.updateKey(admin, "web", "key.005", {
    version: 1,
    translations: { en: "New copy" },
  });
  assert.equal(
    (
      await svc.keyNeighbor(admin, "web", "key.004", {
        direction: "attention",
        language: "fr",
      })
    ).key!.name,
    "key.005",
  );
  assert.equal(
    (
      await svc.keyNeighbor(admin, "web", "key.004", {
        direction: "attention",
        language: "fr",
        status: "complete",
      })
    ).key,
    null,
  );
  const latest = (
    await svc.keyNeighbor(admin, "web", "key.004", { direction: "next" })
  ).key!;
  assert.equal(latest.version, 2);
  assert.deepEqual(latest.outdatedLanguages, ["fr", "ar"]);
});
test("navigation validates filters and retains project and credential boundaries", async () => {
  const { svc } = await fixture();
  const member = { ...admin, admin: false, projects: { web: "user" as const } };
  assert.equal(
    (await svc.keyNeighbor(member, "web", "key.000", { direction: "next" }))
      .key!.name,
    "key.001",
  );
  await assert.rejects(
    svc.keyNeighbor({ ...member, projects: {} }, "web", "key.000", {
      direction: "next",
    }),
    /access/,
  );
  await assert.rejects(
    svc.keyNeighbor(admin, "web", "key.000", {
      direction: "next",
      language: "nl",
    }),
    /Unknown filter language/,
  );
  await assert.rejects(
    svc.keyPage(admin, "web", { limit: 25, languages: ["xx"] }),
    /Unknown filter language/,
  );
  for (const identity of [
    { ...admin, tokenProject: "web" },
    { ...admin, sync: { projectId: "web", credentialId: "x", prefixes: [] } },
    {
      ...admin,
      mcp: {
        projectId: "web",
        credentialId: "x",
        languages: ["fr"],
        allowOverwrite: false,
      },
    },
  ])
    await assert.rejects(
      svc.keyNeighbor(identity, "web", "key.000", { direction: "next" }),
      /Sign in/,
    );
  await assert.rejects(
    svc.keyPage(
      {
        ...admin,
        mcp: {
          projectId: "web",
          credentialId: "x",
          languages: ["fr"],
          allowOverwrite: false,
        },
      },
      "web",
      { limit: 25, languages: ["ar"] },
    ),
    /scope/,
  );
});
test("personal preferences whitelist display choices and discard project data, copy and secrets", () => {
  assert.deepEqual(
    parseEditorPreferences({
      status: "outdated",
      language: "ar",
      pageSize: 25,
      query: "private copy",
      namespace: "billing",
      token: "secret",
      project: "private",
    }),
    { status: "outdated", language: "ar", pageSize: 25 },
  );
  assert.deepEqual(
    parseEditorPreferences({
      status: "bad",
      language: "not_a_locale",
      pageSize: 1000,
    }),
    { status: "all", language: "all", pageSize: 50 },
  );
  assert.deepEqual(parseEditorPreferences(null), {
    status: "all",
    language: "all",
    pageSize: 50,
  });
});

test("preparing plural forms is not a dirty edit or an implicit freshness acceptance", () => {
  assert.equal(
    sameTranslation("", "{count, plural, one {} other {}}", true),
    true,
  );
  assert.equal(
    sameTranslation(
      "{count, plural, other {# items} one {# item}}",
      "{count, plural, one {# item} many {} other {# items}}",
      true,
    ),
    true,
  );
  assert.equal(
    sameTranslation(
      "{count, plural, other {# items}}",
      "{count, plural, other {New # items}}",
      true,
    ),
    false,
  );
  assert.equal(
    sameTranslation(
      "{count, plural, other {# items}}",
      "{n, plural, other {# items}}",
      true,
    ),
    false,
  );
  assert.equal(sameTranslation("Hello", "Hello ", false), false);
});
