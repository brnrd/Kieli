import test from "node:test";
import assert from "node:assert/strict";
import { canEditInline, inlineUpdate } from "../src/components/inline-edit";
import { KieliService } from "../src/server/service";
import { sqliteStore, Conflict } from "../src/server/store";
import { HttpError } from "../src/server/errors";
import type { Identity } from "../src/shared";
const admin: Identity = {
  sub: "admin",
  name: "Admin",
  email: "admin@example.test",
  admin: true,
  projects: {},
};
const user: Identity = {
  ...admin,
  sub: "user",
  admin: false,
  projects: { web: "user" },
};
async function fixture() {
  const svc = new KieliService(await sqliteStore(":memory:"));
  const project = await svc.createProject(admin, {
    id: "web",
    name: "Web",
    sourceLanguage: "en",
    languages: [
      { code: "en", name: "English" },
      { code: "fr", name: "French" },
      { code: "nl", name: "Dutch" },
    ],
  });
  const key = await svc.createKey(admin, "web", {
    name: "welcome",
    description: "Account greeting",
    tags: ["account"],
    namespace: "profile",
    translations: {
      en: "Welcome {name}",
      fr: "Bienvenue {name}",
      nl: "Welkom {name}",
    },
  });
  return { svc, project, key };
}
test("inline payload saves only the chosen locale and retains metadata, other copy and history", async () => {
  const { svc, key } = await fixture();
  const saved = await svc.updateKey(
    user,
    "web",
    key.name,
    inlineUpdate(key, "fr", "Bonjour {name}"),
  );
  assert.equal(saved.translations.fr, "Bonjour {name}");
  assert.equal(saved.translations.en, key.translations.en);
  assert.equal(saved.translations.nl, key.translations.nl);
  assert.equal(saved.description, key.description);
  assert.equal(saved.namespace, key.namespace);
  assert.deepEqual(saved.tags, key.tags);
  assert.equal(saved.id, key.id);
  const history = await svc.keyHistory(user, "web", key.name, { limit: 25 });
  assert.equal(history.items[0]!.after!.translations.fr, "Bonjour {name}");
});
test("a stale inline draft cannot overwrite a concurrent edit in another locale", async () => {
  const { svc, key } = await fixture();
  await svc.updateKey(
    user,
    "web",
    key.name,
    inlineUpdate(key, "nl", "Hallo {name}"),
  );
  await assert.rejects(
    svc.updateKey(
      user,
      "web",
      key.name,
      inlineUpdate(key, "fr", "Salut {name}"),
    ),
    Conflict,
  );
  const current = await svc.key(user, "web", key.name);
  assert.equal(current.translations.fr, key.translations.fr);
  assert.equal(current.translations.nl, "Hallo {name}");
});
test("inline saves use normal placeholder, role and archived-project checks", async () => {
  const { svc, key, project } = await fixture();
  await assert.rejects(
    svc.updateKey(
      user,
      "web",
      key.name,
      inlineUpdate(key, "fr", "Missing argument"),
    ),
    (error) => error instanceof HttpError && error.status === 400,
  );
  await assert.rejects(
    svc.updateKey(user, "web", key.name, inlineUpdate(key, "en", "New {name}")),
    (error) => error instanceof HttpError && error.status === 403,
  );
  await svc.setProjectArchived(admin, "web", {
    version: project.version,
    archived: true,
  });
  await assert.rejects(
    svc.updateKey(
      user,
      "web",
      key.name,
      inlineUpdate(key, "fr", "Salut {name}"),
    ),
    (error) => error instanceof HttpError && error.status === 409,
  );
  assert.equal((await svc.key(user, "web", key.name)).version, key.version);
});
test("plural, linked, read-only and unknown locales use the full editor", async () => {
  const { project, key } = await fixture();
  assert.equal(canEditInline(project, key, "fr", false), true);
  assert.equal(canEditInline(project, key, "en", false), false);
  assert.equal(canEditInline(project, key, "en", true), true);
  assert.equal(
    canEditInline(
      { ...project, archivedAt: new Date().toISOString() },
      key,
      "fr",
      true,
    ),
    false,
  );
  assert.equal(canEditInline(project, key, "de", true), false);
  assert.equal(
    canEditInline(project, { ...key, plural: true }, "fr", true),
    false,
  );
  assert.equal(
    canEditInline(
      project,
      { ...key, translations: { ...key.translations, nl: "[%key:other%]" } },
      "fr",
      true,
    ),
    false,
  );
  assert.equal(
    canEditInline(
      project,
      { ...key, translations: { en: "{n, plural, one {one} other {many}}" } },
      "fr",
      true,
    ),
    false,
  );
});
