import test from "node:test";
import assert from "node:assert/strict";
import { Installation } from "../src/server/installation";
import { LocalAuth } from "../src/server/local-auth";
import { verifyPassword } from "../src/server/passwords";
import { sqliteStore } from "../src/server/store";
import { HttpError } from "../src/server/errors";

process.env.AUTH_MODE = "local";
process.env.NODE_ENV = "test";
process.env.APP_ORIGIN = "http://localhost:4321";
process.env.KEYLO_INSTALL_TOKEN = "A1".repeat(24);
const token = process.env.KEYLO_INSTALL_TOKEN;
const input = {
  token,
  name: "Workspace owner",
  email: "OWNER@example.com",
  password: "Voyager-kestrel-silver-83! drawer",
};
const denied = (status: number) => (error: unknown) =>
  error instanceof HttpError && error.status === status;
async function fixture() {
  const store = await sqliteStore(":memory:");
  const install = new Installation(store, async () => token);
  return { store, install, auth: new LocalAuth(store) };
}
test("installation is explicitly enabled, local-only, and production requires an AWS secret", async () => {
  const f = await fixture();
  assert.equal(await f.install.available(), true);
  delete process.env.KEYLO_INSTALL_TOKEN;
  assert.equal(await f.install.available(), false);
  process.env.KEYLO_INSTALL_TOKEN = token;
  process.env.NODE_ENV = "production";
  process.env.APP_ORIGIN = "https://copy.example.com";
  assert.equal(await f.install.available(), false);
  process.env.KEYLO_INSTALL_SECRET_ARN =
    "arn:aws:secretsmanager:eu-west-1:123456789012:secret:fixture";
  assert.equal(await f.install.available(), true);
  process.env.AUTH_MODE = "saml";
  assert.equal(await f.install.available(), false);
  process.env.AUTH_MODE = "local";
  process.env.NODE_ENV = "test";
  process.env.APP_ORIGIN = "http://localhost:4321";
  delete process.env.KEYLO_INSTALL_SECRET_ARN;
});
test("incorrect secrets and invalid passwords cannot claim or partially initialize a workspace", async () => {
  const f = await fixture();
  await assert.rejects(
    f.install.complete({ ...input, token: "B2".repeat(24) }, "fixture"),
    denied(403),
  );
  await assert.rejects(
    f.install.complete({ ...input, password: "passwordpassword" }, "fixture"),
  );
  assert.equal(await f.store.get("AUTH_CONTROL", "ADMINS"), undefined);
  assert.equal((await f.store.list("USERS", "USER#")).length, 0);
  assert.equal(await f.install.available(), true);
});
test("installation creates one active admin with a hashed password and secret-free audit", async () => {
  const f = await fixture();
  const user = await f.install.complete(input, "fixture");
  assert.equal(user.email, "owner@example.com");
  assert.equal(user.workspaceRole, "admin");
  assert.equal(user.status, "active");
  assert.equal(await verifyPassword(user.passwordHash!, input.password), true);
  assert.equal(
    (
      await f.auth.login(
        { email: user.email, password: input.password },
        "fixture",
      )
    ).id,
    user.id,
  );
  assert.deepEqual(await f.store.get("AUTH_CONTROL", "ADMINS"), {
    version: 1,
    activeAdmins: 1,
  });
  assert.equal(await f.install.available(), false);
  await assert.rejects(
    f.install.complete({ ...input, email: "second@example.com" }, "other"),
    denied(409),
  );
  const data = JSON.stringify(await f.store.list("AUTH_AUDIT", ""));
  assert.ok(data.includes("installation.completed"));
  assert.ok(!data.includes(token));
  assert.ok(!data.includes(input.password));
});
test("concurrent installers commit exactly one administrator", async () => {
  const f = await fixture();
  const results = await Promise.allSettled([
    f.install.complete(input, "first"),
    f.install.complete({ ...input, email: "other@example.com" }, "second"),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal((await f.store.list("USERS", "USER#")).length, 1);
  assert.deepEqual(await f.store.get("AUTH_CONTROL", "ADMINS"), {
    version: 1,
    activeAdmins: 1,
  });
});
test("operator bootstrap and web installation share the same one-time guard", async () => {
  const f = await fixture();
  await f.auth.bootstrap({
    name: "Operator admin",
    email: "operator@example.com",
  });
  assert.equal(await f.install.available(), false);
  await assert.rejects(f.install.complete(input, "fixture"), denied(409));
  assert.equal((await f.store.list("USERS", "USER#")).length, 1);
});
test("rotated secrets are read on each attempt and invalid attempts share a rate limit", async () => {
  const f = await fixture();
  let current = "B2".repeat(24);
  const install = new Installation(f.store, async () => current);
  await assert.rejects(install.complete(input, "fixture"), denied(403));
  current = token;
  await install.complete(input, "fixture");
  const limited = await fixture();
  for (let i = 0; i < 30; i++)
    await assert.rejects(
      limited.install.complete(
        { ...input, token: "B2".repeat(24) },
        "same-client",
      ),
      denied(403),
    );
  await assert.rejects(
    limited.install.complete(input, "same-client"),
    denied(429),
  );
  assert.equal(await limited.install.available(), true);
});
