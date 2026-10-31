import test from "node:test";
import assert from "node:assert/strict";
import { KeyloService } from "../src/server/service";
import { ProjectHistory } from "../src/server/project-history";
import { sqliteStore } from "../src/server/store";
import { workspaceOverview } from "../src/server/workspace";
import { projectConflicts } from "../src/project-names";
import { checkOrigin } from "../src/server/auth";
import type { Identity } from "../src/shared";
const admin: Identity = {
  sub: "admin",
  name: "Admin",
  email: "admin@example.com",
  admin: true,
  projects: {},
};
const project = {
  id: "web",
  name: "Acme Website",
  sourceLanguage: "en",
  languages: [
    { code: "en", name: "English" },
    { code: "fr", name: "French" },
  ],
};
const status = (code: number) => (error: any) => error.status === code;
async function fixture() {
  const store = await sqliteStore(":memory:");
  const svc = new KeyloService(store);
  await svc.createProject(admin, project);
  return { store, svc };
}
test("duplicate project names and IDs are checked by the form and server, including legacy projects", async () => {
  const { svc, store } = await fixture();
  await store.put("WORKSPACE", "PROJECT#legacy", {
    ...project,
    id: "legacy",
    name: "Legacy",
    version: 1,
  });
  await assert.rejects(
    svc.createProject(admin, {
      ...project,
      id: "legacy-copy",
      name: " legacy ",
    }),
    /name already exists/,
  );
  assert.deepEqual(projectConflicts([project], "  ACME   WEBSITE ", "other"), {
    name: true,
    id: false,
  });
  assert.deepEqual(
    projectConflicts([project], project.name, project.id, project.id),
    { name: false, id: false },
  );
  await assert.rejects(
    svc.createProject(admin, {
      ...project,
      id: "other",
      name: "Ａｃｍｅ Website",
    }),
    /name already exists/,
  );
  await assert.rejects(
    svc.createProject(admin, { ...project, name: "Other" }),
    /ID already exists/,
  );
  await svc.createProject(admin, { ...project, id: "app", name: "Mobile" });
  await assert.rejects(
    svc.updateProject(admin, "app", { ...project, id: "app", version: 1 }),
    /name already exists/,
  );
});
test("concurrent creates and renames reserve a normalized name atomically", async () => {
  const { svc } = await fixture();
  const creates = await Promise.allSettled(
    ["one", "two"].map((id) =>
      svc.createProject(admin, { ...project, id, name: "Shared" }),
    ),
  );
  assert.equal(
    creates.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    (await svc.bootstrap(admin)).projects.filter((row) => row.name === "Shared")
      .length,
    1,
  );
  await svc.createProject(admin, { ...project, id: "mobile", name: "Mobile" });
  const renames = await Promise.allSettled(
    [project.id, "mobile"].map((id) =>
      svc.updateProject(admin, id, {
        ...project,
        id,
        name: "Renamed",
        version: 1,
      }),
    ),
  );
  assert.equal(
    renames.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const renamed = (await svc.bootstrap(admin)).projects.find(
    (row) => row.name === "Renamed",
  )!;
  await svc.updateProject(admin, renamed.id, {
    ...project,
    id: renamed.id,
    version: renamed.version,
    name: "Released",
  });
  await svc.createProject(admin, { ...project, id: "reused", name: "Renamed" });
});
test("snapshot restoration cannot bypass project-name uniqueness", async () => {
  const { svc, store } = await fixture();
  const history = new ProjectHistory(store);
  const snapshot = await history.create(admin, "web", "Before rename");
  await svc.updateProject(admin, "web", {
    ...project,
    name: "Renamed",
    version: 1,
  });
  await svc.createProject(admin, { ...project, id: "new-owner" });
  await assert.rejects(
    history.restore(admin, "web", snapshot.id, 2),
    /name already exists/,
  );
  assert.equal((await svc.project(admin, "web")).name, "Renamed");
});
test("workspace totals count target values and all admin endpoints reject scoped credentials and members", async () => {
  const { svc, store } = await fixture();
  const key = await svc.createKey(admin, "web", {
    name: "hello",
    translations: { en: "Hello", fr: "Bonjour" },
  });
  await svc.updateKey(admin, "web", key.name, {
    version: 1,
    translations: { en: "Welcome" },
  });
  await svc.createKey(admin, "web", {
    name: "missing",
    translations: { en: "Missing" },
  });
  await svc.createKey(admin, "web", {
    name: "current",
    translations: { en: "Current", fr: "Actuel" },
  });
  await svc.createProject(admin, {
    ...project,
    id: "source-only",
    name: "Source only",
    languages: [project.languages[0]!],
  });
  await svc.createKey(admin, "source-only", {
    name: "plain",
    translations: { en: "Plain" },
  });
  const overview = await workspaceOverview(admin, store);
  assert.deepEqual(overview.totals, {
    keys: 4,
    current: 1,
    outdated: 1,
    missing: 1,
    targetSlots: 3,
  });
  for (const identity of [
    { ...admin, admin: false, projects: { web: "manager" as const } },
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
    await assert.rejects(workspaceOverview(identity, store), status(403));
});
test("demo origin checks accept loopback aliases on the request port but production/local checks stay exact", () => {
  const original = {
    mode: process.env.AUTH_MODE,
    env: process.env.NODE_ENV,
    origin: process.env.APP_ORIGIN,
  };
  try {
    Object.assign(process.env, {
      AUTH_MODE: "demo",
      NODE_ENV: "development",
      APP_ORIGIN: "http://localhost:4321",
    });
    const request = (origin: string) =>
      new Request("http://127.0.0.1:4999/api/projects", {
        method: "POST",
        headers: { Origin: origin },
      });
    checkOrigin(request("http://localhost:4999"));
    checkOrigin(request("http://127.0.0.1:4999"));
    for (const origin of [
      "http://localhost:4998",
      "http://evil.example",
      "null",
      "http://localhost.evil.example:4999",
    ])
      assert.throws(() => checkOrigin(request(origin)), status(403));
    process.env.AUTH_MODE = "local";
    assert.throws(
      () => checkOrigin(request("http://localhost:4999")),
      status(403),
    );
    process.env.NODE_ENV = "production";
    process.env.APP_ORIGIN = "https://copy.example.com";
    assert.throws(
      () => checkOrigin(request("http://localhost:4999")),
      status(403),
    );
    checkOrigin(request("https://copy.example.com"));
  } finally {
    for (const [key, value] of [
      ["AUTH_MODE", original.mode],
      ["NODE_ENV", original.env],
      ["APP_ORIGIN", original.origin],
    ]) {
      if (value === undefined) delete process.env[key!];
      else process.env[key!] = value;
    }
  }
});
