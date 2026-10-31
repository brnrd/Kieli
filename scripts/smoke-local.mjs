import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Exercises local accounts through the compiled HTTP app and the operator CLI.
// All credentials and the database are disposable fixtures.
const directory = await mkdtemp(join(tmpdir(), "keylo-local-smoke-"));
const origin = "http://127.0.0.1:4326";
const env = {
  ...process.env,
  NODE_ENV: "development",
  AUTH_MODE: "local",
  STORAGE_DRIVER: "sqlite",
  SQLITE_PATH: join(directory, "data.sqlite"),
  HOST: "127.0.0.1",
  PORT: "4326",
  APP_ORIGIN: origin,
};
delete env.SESSION_SECRET;
delete env.OKTA_ISSUER;
delete env.OKTA_CLIENT_ID;
delete env.OKTA_CLIENT_SECRET;
const password = "Voyager-kestrel-silver-83! drawer";
const newPassword = "Prairie-ember-royal-92! spindle";
let server;
let logs = "";
async function bootstrap() {
  const cli = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "src/scripts/users.ts",
      "bootstrap",
      "--email",
      "admin@example.com",
      "--name",
      "Test admin",
    ],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  let error = "";
  cli.stdout.on("data", (data) => {
    output += data;
  });
  cli.stderr.on("data", (data) => {
    error += data;
  });
  const [code] = await once(cli, "exit");
  assert.equal(code, 0, error);
  const url = output.split("\n").find((line) => line.startsWith(origin));
  assert.ok(url, "Bootstrap must issue an activation URL");
  return new URL(url).searchParams.get("token");
}
function cookie(response) {
  const match = response.headers
    .getSetCookie()
    .find((value) => /^keylo_session=[a-f0-9]{64};/.test(value));
  assert.ok(match, "A successful sign-in must issue an opaque session");
  assert.match(match, /HttpOnly/i);
  assert.match(match, /SameSite=Lax/i);
  return match.split(";")[0];
}
async function request(path, method = "GET", data, session, headers = {}) {
  return fetch(`${origin}${path}`, {
    method,
    headers: {
      "Sec-Fetch-Site": "same-origin",
      ...(!["GET", "HEAD"].includes(method) ? { Origin: origin } : {}),
      ...(data === undefined ? {} : { "Content-Type": "application/json" }),
      ...(session ? { Cookie: session } : {}),
      ...headers,
    },
    body: data === undefined ? undefined : JSON.stringify(data),
    redirect: "manual",
  });
}
async function json(path, method, data, session, expected = 200) {
  const response = await request(path, method, data, session);
  assert.equal(response.status, expected, await response.clone().text());
  return response.json();
}
try {
  const setupToken = await bootstrap();
  server = spawn(process.execPath, ["dist/server/entry.mjs"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (data) => {
    logs += data;
  });
  server.stderr.on("data", (data) => {
    logs += data;
  });
  server.on("error", (error) => {
    logs += error.message;
  });
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (server.exitCode !== null)
      throw new Error(`Compiled server failed: ${logs}`);
    try {
      ready = (await fetch(`${origin}/api/health`)).ok;
    } catch {}
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, `Server did not become ready: ${logs}`);
  assert.equal((await request("/api/bootstrap")).status, 401);
  assert.equal((await request("/projects")).headers.get("location"), "/login");
  const signIn = await request("/login");
  assert.match(await signIn.text(), /Email/);
  assert.equal(signIn.headers.get("Referrer-Policy"), "no-referrer");
  assert.equal(
    (
      await request(
        "/api/auth/login",
        "POST",
        { email: "admin@example.com", password },
        undefined,
        { Origin: "https://attacker.example" },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await request("/api/auth/login", "POST", {
        email: "unknown@example.com",
        password,
      })
    ).status,
    401,
  );
  const activation = await request("/api/auth/activate", "POST", {
    token: setupToken,
    password,
  });
  assert.equal(activation.status, 200, await activation.clone().text());
  let admin = cookie(activation);
  assert.equal(
    (
      await request("/api/auth/activate", "POST", {
        token: setupToken,
        password,
      })
    ).status,
    400,
  );
  const workspace = await json("/api/bootstrap", "GET", undefined, admin);
  assert.equal(workspace.authMode, "local");
  assert.equal(workspace.identity.admin, true);
  const peoplePage = await request("/users", "GET", undefined, admin);
  assert.equal(peoplePage.status, 200);
  assert.match(await peoplePage.text(), /People &amp; access/);
  for (const path of ["/admin", "/admin/people", "/admin/security"])
    assert.equal((await request(path, "GET", undefined, admin)).status, 200);
  assert.equal(
    (await request("/api/workspace/overview", "GET", undefined, admin)).status,
    200,
  );
  const accounts = await json("/api/users", "GET", undefined, admin);
  assert.equal(accounts.items.length, 1);
  assert.equal(JSON.stringify(accounts).includes("passwordHash"), false);
  await json(
    "/api/projects",
    "POST",
    {
      id: "local-smoke",
      name: "Local account project",
      sourceLanguage: "en",
      languages: [
        { code: "en", name: "English" },
        { code: "fr", name: "French" },
      ],
    },
    admin,
    201,
  );
  const invitation = await json(
    "/api/users",
    "POST",
    {
      email: "member@example.com",
      name: "Test member",
      projects: { "local-smoke": "user" },
    },
    admin,
    201,
  );
  const accepted = await request("/api/auth/activate", "POST", {
    token: new URL(invitation.url).searchParams.get("token"),
    password,
  });
  assert.equal(accepted.status, 200, await accepted.clone().text());
  let member = cookie(accepted);
  assert.equal(
    (await request("/api/workspace/overview", "GET", undefined, member)).status,
    403,
  );
  assert.equal((await request("/admin", "GET", undefined, member)).status, 404);
  assert.equal(
    (await request("/admin/people", "GET", undefined, member)).status,
    404,
  );

  assert.equal(
    (await request("/api/users", "GET", undefined, member)).status,
    403,
  );
  assert.equal(
    (await request("/api/projects", "POST", {}, member)).status,
    403,
  );
  assert.equal(
    (
      await request(
        "/api/projects/local-smoke/keys",
        "POST",
        { name: "no-create", translations: {} },
        member,
      )
    ).status,
    403,
  );
  await json(
    "/api/projects/local-smoke/keys",
    "POST",
    { name: "hello", translations: { en: "Hello" } },
    admin,
    201,
  );
  assert.equal(
    (
      await request(
        "/api/projects/local-smoke/keys/hello",
        "PATCH",
        { version: 1, translations: { en: "Hi" } },
        member,
      )
    ).status,
    403,
  );
  await json(
    "/api/projects/local-smoke/keys/hello",
    "PATCH",
    { version: 1, translations: { fr: "Bonjour" } },
    member,
  );
  let person = (await json("/api/users?q=member%40", "GET", undefined, admin))
    .items[0];
  person = await json(
    `/api/users/${person.id}`,
    "PATCH",
    {
      version: person.version,
      name: person.name,
      projects: person.projects,
      workspaceRole: "member",
      status: "disabled",
    },
    admin,
  );
  assert.equal(
    (await request("/api/bootstrap", "GET", undefined, member)).status,
    401,
  );
  assert.equal(
    (
      await request("/api/auth/login", "POST", {
        email: person.email,
        password,
      })
    ).status,
    401,
  );
  person = await json(
    `/api/users/${person.id}`,
    "PATCH",
    {
      version: person.version,
      name: person.name,
      projects: person.projects,
      workspaceRole: "member",
      status: "active",
    },
    admin,
  );
  const reset = await json(
    `/api/users/${person.id}/link`,
    "POST",
    { version: person.version },
    admin,
  );
  const resetResponse = await request("/api/auth/activate", "POST", {
    token: new URL(reset.url).searchParams.get("token"),
    password: newPassword,
  });
  assert.equal(resetResponse.status, 200, await resetResponse.clone().text());
  member = cookie(resetResponse);
  assert.equal(
    (
      await request("/api/auth/login", "POST", {
        email: person.email,
        password,
      })
    ).status,
    401,
  );
  const signedIn = await request("/api/auth/login", "POST", {
    email: person.email,
    password: newPassword,
  });
  assert.equal(signedIn.status, 200);
  const otherDevice = cookie(signedIn);
  const passwordResponse = await request(
    "/api/auth/password",
    "POST",
    { currentPassword: newPassword, newPassword: password },
    member,
  );
  assert.equal(
    passwordResponse.status,
    200,
    await passwordResponse.clone().text(),
  );
  member = cookie(passwordResponse);
  assert.equal(
    (await request("/api/bootstrap", "GET", undefined, otherDevice)).status,
    401,
  );
  assert.equal(
    (await request("/api/bootstrap", "GET", undefined, member)).status,
    200,
  );
  person = (await json("/api/users?q=member%40", "GET", undefined, admin))
    .items[0];
  await json(
    `/api/users/${person.id}/revoke`,
    "POST",
    { version: person.version },
    admin,
  );
  assert.equal(
    (await request("/api/bootstrap", "GET", undefined, member)).status,
    401,
  );
  const events = await json("/api/users/audit", "GET", undefined, admin);
  assert.ok(
    events.items.some((event) => event.action === "user.sessions_revoked"),
  );
  assert.equal(JSON.stringify(events).includes(password), false);
  const logout = await request("/auth/logout", "POST", undefined, admin);
  assert.equal(logout.status, 302);
  assert.equal(
    (await request("/api/bootstrap", "GET", undefined, admin)).status,
    401,
  );
  const finalSignIn = await request("/api/auth/login", "POST", {
    email: "admin@example.com",
    password,
  });
  const activeAdmin = cookie(finalSignIn);
  const secondDevice = cookie(
    await request("/api/auth/login", "POST", {
      email: "admin@example.com",
      password,
    }),
  );
  const personal = await json(
    "/api/projects/local-smoke/mcp-tokens",
    "POST",
    { name: "Self-revoke fixture", languages: ["fr"] },
    activeAdmin,
    201,
  );
  const mcp = () =>
    request(
      "/mcp",
      "POST",
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      undefined,
      {
        authorization: `Bearer ${personal.secret}`,
        accept: "application/json, text/event-stream",
      },
    );
  assert.equal((await mcp()).status, 200);
  assert.equal(
    (
      await request("/api/auth/revoke-all", "POST", undefined, activeAdmin, {
        Origin: "https://attacker.example",
      })
    ).status,
    403,
  );
  await json("/api/auth/revoke-all", "POST", undefined, activeAdmin);
  assert.equal(
    (await request("/api/bootstrap", "GET", undefined, secondDevice)).status,
    401,
  );
  assert.equal((await mcp()).status, 401);
  console.log(
    "Local accounts HTTP smoke passed: operator bootstrap, activation, CSRF, login, role enforcement, disable/reactivate, reset, password rotation, session revocation, audit, and logout replay.",
  );
} finally {
  if (server?.exitCode === null) {
    server.kill("SIGTERM");
    await Promise.race([
      once(server, "exit"),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
  }
  await rm(directory, { recursive: true, force: true });
}
