import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { unzipSync, strFromU8 } from "fflate";

// Exercises the compiled HTTP boundary and real CLI using a disposable database.
const directory = await mkdtemp(join(tmpdir(), "keylo-smoke-"));
const origin = "http://127.0.0.1:4325";
const server = spawn(process.execPath, ["dist/server/entry.mjs"], {
  env: {
    ...process.env,
    NODE_ENV: "development",
    AUTH_MODE: "demo",
    STORAGE_DRIVER: "sqlite",
    SQLITE_PATH: join(directory, "data.sqlite"),
    HOST: "127.0.0.1",
    PORT: "4325",
    APP_ORIGIN: origin,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
server.stdout.on("data", (data) => {
  logs += data;
});
server.stderr.on("data", (data) => {
  logs += data;
});
server.on("error", (error) => {
  logs += error.message;
});
async function request(path, method = "GET", data, headers = {}) {
  return fetch(`${origin}${path}`, {
    method,
    headers: {
      "Sec-Fetch-Site": "same-origin",
      ...(!["GET", "HEAD"].includes(method) ? { Origin: origin } : {}),
      ...(data === undefined
        ? {}
        : { "Content-Type": "application/json", Origin: origin }),
      ...headers,
    },
    body: data === undefined ? undefined : JSON.stringify(data),
    redirect: "manual",
  });
}
try {
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
  const metadata = {
    id: "smoke",
    name: "HTTP smoke",
    sourceLanguage: "en",
    languages: [
      { code: "en", name: "English" },
      { code: "fr", name: "French" },
    ],
  };
  assert.equal(
    (
      await request("/api/projects", "POST", metadata, {
        Origin: "https://attacker.example",
      })
    ).status,
    403,
  );
  assert.equal((await request("/api/projects", "POST", metadata)).status, 201);
  const duplicateName = await request("/api/projects", "POST", {
    ...metadata,
    id: "duplicate",
    name: "  HTTP  SMOKE ",
  });
  assert.equal(duplicateName.status, 409);
  assert.match((await duplicateName.json()).error, /name already exists/);
  assert.equal(
    (await request("/api/projects", "POST", { ...metadata, name: "Another" }))
      .status,
    409,
  );
  for (const path of ["/admin", "/admin/people", "/admin/security", "/users"])
    assert.equal((await request(path)).status, 200);

  const created = await request("/api/projects/smoke/keys", "POST", {
    name: "home.title",
    translations: { en: "Hello", fr: "Bonjour" },
  });
  assert.equal(created.status, 201);
  assert.equal(
    (
      await request("/api/projects/smoke/keys/home.title", "PATCH", {
        version: 1,
        translations: { fr: "Salut" },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request("/api/projects/smoke/keys/home.title", "PATCH", {
        version: 1,
        translations: { fr: "Stale" },
      })
    ).status,
    409,
  );
  const page = await (
    await request("/api/projects/smoke/keys?limit=25&q=Salut")
  ).json();
  assert.equal(page.items.length, 1);
  assert.equal(page.stats.totalKeys, 1);
  assert.equal(page.items[0].translations.fr, "Salut");
  assert.equal(
    (await request("/api/projects/smoke/keys?cursor=invalid")).status,
    400,
  );
  assert.equal(
    (
      await request("/api/projects/smoke/keys", "POST", {
        name: "large",
        translations: { en: "x".repeat(300000) },
      })
    ).status,
    413,
  );
  const response = await request("/projects/smoke");
  const csp = response.headers.get("Content-Security-Policy");
  assert.ok(csp?.includes("script-src 'self' 'sha256-"));
  assert.ok(!csp.includes("'unsafe-inline'"));
  assert.equal(response.headers.get("X-Frame-Options"), "DENY");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const workspaceStats = await (
    await request("/api/workspace/overview")
  ).json();
  assert.equal(workspaceStats.projects.length, 1);
  assert.equal(workspaceStats.totals.keys, 1);
  assert.equal(workspaceStats.totals.current, 1);
  const tokenResponse = await request("/api/projects/smoke/tokens", "POST", {
    name: "Disposable smoke token",
    expiresInDays: 1,
  });
  assert.equal(tokenResponse.status, 201);
  const token = await tokenResponse.json();
  const authorization = { Authorization: `Bearer ${token.secret}` };
  assert.equal(
    (await request("/api/workspace/overview", "GET", undefined, authorization))
      .status,
    403,
  );
  assert.equal(
    (await request("/admin", "GET", undefined, authorization)).status,
    403,
  );

  assert.equal(
    (
      await request(
        "/api/projects/smoke/export",
        "GET",
        undefined,
        authorization,
      )
    ).status,
    200,
  );
  assert.equal(
    (await request("/api/bootstrap", "GET", undefined, authorization)).status,
    403,
  );
  assert.equal(
    (
      await request(
        "/api/projects/other/export",
        "GET",
        undefined,
        authorization,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await request(
        "/api/projects/smoke/keys",
        "POST",
        { name: "no-write", translations: {} },
        authorization,
      )
    ).status,
    403,
  );
  const cli = spawn(
    process.execPath,
    [
      "cli/keylo.mjs",
      "pull",
      "--url",
      origin,
      "--project",
      "smoke",
      "--out",
      join(directory, "locales"),
      "--format",
      "nested",
    ],
    {
      env: { ...process.env, KEYLO_TOKEN: token.secret },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let cliError = "";
  cli.stderr.on("data", (data) => {
    cliError += data;
  });
  const [exitCode] = await once(cli, "exit");
  assert.equal(exitCode, 0, cliError);
  assert.deepEqual(
    JSON.parse(await readFile(join(directory, "locales/fr.json"), "utf8")),
    { home: { title: "Salut" } },
  );
  const native = await request(
    "/api/projects/smoke/export?format=strings&languages=fr",
    "GET",
    undefined,
    authorization,
  );
  assert.equal(native.status, 200);
  const nativeData = await native.json();
  assert.deepEqual(nativeData.files, [
    { name: "fr.strings", content: '"home.title" = "Salut";\n' },
  ]);
  assert.equal("translations" in nativeData, false);
  const zipped = await request(
    "/api/projects/smoke/export?format=strings&languages=fr&download=zip",
    "GET",
    undefined,
    authorization,
  );
  assert.equal(zipped.status, 200);
  assert.equal(zipped.headers.get("content-type"), "application/zip");
  const files = unzipSync(new Uint8Array(await zipped.arrayBuffer()));
  assert.deepEqual(Object.keys(files), ["fr.strings"]);
  assert.equal(strFromU8(files["fr.strings"]), '"home.title" = "Salut";\n');
  assert.equal(
    (
      await request(
        "/api/projects/smoke/export?format=android",
        "GET",
        undefined,
        authorization,
      )
    ).status,
    422,
  );
  assert.equal(
    (
      await request(
        "/api/projects/smoke/export?format=docx",
        "GET",
        undefined,
        authorization,
      )
    ).status,
    400,
  );
  assert.equal(
    (await request("/api/imports/files/start", "POST", {}, authorization))
      .status,
    403,
  );
  const nativeCli = spawn(
    process.execPath,
    [
      "cli/keylo.mjs",
      "pull",
      "--url",
      origin,
      "--project",
      "smoke",
      "--out",
      join(directory, "strings"),
      "--format",
      "strings",
      "--languages",
      "fr",
    ],
    {
      env: { ...process.env, KEYLO_TOKEN: token.secret },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let nativeError = "";
  nativeCli.stderr.on("data", (data) => {
    nativeError += data;
  });
  const [nativeExit] = await once(nativeCli, "exit");
  assert.equal(nativeExit, 0, nativeError);
  assert.equal(
    await readFile(join(directory, "strings/fr.strings"), "utf8"),
    '"home.title" = "Salut";\n',
  );
  assert.equal(
    (
      await request("/api/projects/smoke/keys", "POST", {
        name: "invalid.arguments",
        translations: { en: "Hello {name}", fr: "Bonjour" },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(
        "/api/projects/smoke/export?requireCurrent=true",
        "GET",
        undefined,
        authorization,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await request("/api/projects/smoke/keys/home.title", "PATCH", {
        version: 2,
        translations: { en: "Hello {name}" },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request(
        "/api/projects/smoke/export?languages=fr&requireCurrent=true&fallback=true",
        "GET",
        undefined,
        authorization,
      )
    ).status,
    422,
  );
  const strictCli = spawn(
    process.execPath,
    [
      "cli/keylo.mjs",
      "pull",
      "--url",
      origin,
      "--project",
      "smoke",
      "--languages",
      "fr",
      "--require-current",
      "--out",
      join(directory, "locales"),
    ],
    {
      env: { ...process.env, KEYLO_TOKEN: token.secret },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let strictError = "";
  strictCli.stderr.on("data", (data) => {
    strictError += data;
  });
  assert.equal((await once(strictCli, "exit"))[0], 1);
  assert.match(strictError, /422/);
  assert.deepEqual(
    JSON.parse(await readFile(join(directory, "locales/fr.json"), "utf8")),
    { home: { title: "Salut" } },
  );
  const tokens = await (await request("/api/projects/smoke/tokens")).json();
  const revoked = await request(
    `/api/projects/smoke/tokens/${tokens[0].id}`,
    "DELETE",
  );
  assert.equal(revoked.status, 204, await revoked.text());
  assert.equal(
    (
      await request(
        "/api/projects/smoke/export",
        "GET",
        undefined,
        authorization,
      )
    ).status,
    401,
  );
  console.log(
    "HTTP smoke passed: CSP, origins, roles, bounded bodies, pagination, version conflicts, token scope/revocation, shared argument checks, strict freshness gates and real CLI export.",
  );
} finally {
  server.kill("SIGTERM");
  await Promise.race([
    once(server, "exit"),
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ]);
  await rm(directory, { recursive: true, force: true });
}
