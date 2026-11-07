import test from "node:test";
import assert from "node:assert/strict";
import { sqliteStore } from "../src/server/store";
import { KieliService } from "../src/server/service";
import type { Identity } from "../src/shared";
const admin: Identity = {
  sub: "a",
  name: "Admin",
  email: "a@example.test",
  admin: true,
  projects: {},
};
async function fixture() {
  const svc = new KieliService(await sqliteStore(":memory:"));
  await svc.createProject(admin, {
    id: "web",
    name: "Web",
    sourceLanguage: "en",
    languages: [
      { code: "en", name: "English" },
      { code: "fr", name: "French" },
    ],
  });
  await svc.createKey(admin, "web", {
    name: "base",
    namespace: "shared",
    translations: { en: "Hello", fr: "Bonjour" },
  });
  await svc.createKey(admin, "web", {
    name: "linked",
    namespace: "home",
    translations: { en: "[%key:base%]", fr: "[%key:base%]" },
  });
  await svc.createKey(admin, "web", {
    name: "missing",
    namespace: "other",
    translations: { en: "Other" },
  });
  return svc;
}
test("key and namespace selections export resolved references without including dependencies", async () => {
  const svc = await fixture();
  for (const selection of [{ keys: ["linked"] }, { namespace: "home" }]) {
    const data = await svc.export(
      admin,
      "web",
      ["fr"],
      "flat",
      false,
      true,
      selection,
    );
    assert.deepEqual(
      { ...(data.translations.fr as object) },
      { linked: "Bonjour" },
    );
  }
  const all = await svc.export(admin, "web", ["en"], "flat", false);
  assert.equal(Object.keys(all.translations.en as object).length, 3);
});
test("strict gates inspect only selected keys, while missing keys and empty/ambiguous scopes reject", async () => {
  const svc = await fixture();
  await assert.rejects(
    svc.export(admin, "web", ["fr"], "flat", false, true, {
      keys: ["missing"],
    }),
  );
  for (const selection of [
    { keys: [] },
    { keys: ["gone"] },
    { namespace: "gone" },
    { namespace: "" },
    { keys: ["base"], namespace: "shared" },
    { keys: ["../bad"] },
  ])
    await assert.rejects(
      svc.export(admin, "web", ["en"], "flat", false, false, selection),
    );
});
test("subset exports keep project authorization and archived/disabled explicit reads", async () => {
  const svc = await fixture();
  await assert.rejects(
    svc.export(
      { ...admin, admin: false },
      "web",
      ["en"],
      "flat",
      false,
      false,
      { keys: ["base"] },
    ),
  );
  await svc.setLanguageEnabled(admin, "web", "fr", {
    version: 1,
    enabled: false,
  });
  await svc.setProjectArchived(admin, "web", { version: 2, archived: true });
  const data = await svc.export(
    { ...admin, tokenProject: "web" },
    "web",
    ["fr"],
    "flat",
    false,
    true,
    { keys: ["base"] },
  );
  assert.equal(
    (data.translations.fr as Record<string, string>).base,
    "Bonjour",
  );
});
