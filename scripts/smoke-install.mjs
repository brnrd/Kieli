import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { packageAws } from "./package-aws.mjs";

const directory = await mkdtemp(join(tmpdir(), "kieli-install-"));
const origin = "http://127.0.0.1:4329";
const token = "Fixture1".repeat(6);
const password = "Voyager-kestrel-silver-83! drawer";
const packaged = await packageAws({
  out: join(directory, "package"),
  localTest: true,
});
const runtime = join(directory, "extracted");
await promisify(execFile)("unzip", [
  "-q",
  join(packaged.directory, packaged.file),
  "-d",
  runtime,
]);
assert.ok(
  (await stat(join(runtime, "run.sh"))).mode & 0o111,
  "ZIP must preserve the startup script's executable mode",
);
const server = spawn(join(runtime, "run.sh"), [], {
  cwd: runtime,
  env: {
    ...process.env,
    KIELI_INSTALL_SECRET_ARN: "",
    LAMBDA_TASK_ROOT: runtime,
    NODE_ENV: "development",
    AUTH_MODE: "local",
    KIELI_INSTALL_TOKEN: token,
    STORAGE_DRIVER: "sqlite",
    SQLITE_PATH: join(directory, "data.sqlite"),
    HOST: "127.0.0.1",
    PORT: "4329",
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
const api = (path, method = "GET", data, headers = {}) =>
  fetch(origin + path, {
    method,
    redirect: "manual",
    headers: { origin, "content-type": "application/json", ...headers },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
try {
  let ready = false;
  for (let attempt = 0; attempt < 70; attempt++) {
    if (server.exitCode !== null)
      throw new Error(`Packaged server failed: ${logs}`);
    try {
      ready = (await fetch(origin + "/api/health")).ok;
    } catch {}
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, `Packaged server did not become ready: ${logs}`);
  assert.equal((await api("/login")).headers.get("location"), "/auth/install");
  const page = await api("/auth/install");
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  const html = await page.text();
  assert.ok(html.includes("Create the first administrator"));
  assert.ok(!html.includes(token));
  const asset = html.match(/(?:src|href)="([^\"]*\/_astro\/[^\"]+)"/);
  assert.ok(asset, "Expected a bundled static asset");
  assert.equal((await fetch(new URL(asset[1], origin))).status, 200);
  const data = {
    token,
    name: "Install owner",
    email: "OWNER@example.com",
    password,
  };
  assert.equal(
    (
      await api("/api/auth/install", "POST", data, {
        origin: "https://attacker.example",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await api("/api/auth/install", "POST", {
        ...data,
        token: "Wrong123".repeat(6),
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await api("/api/auth/install", "POST", {
        ...data,
        password: "passwordpassword",
      })
    ).status,
    400,
  );
  assert.equal((await api("/api/bootstrap")).status, 401);
  const results = await Promise.all([
    api("/api/auth/install", "POST", data),
    api("/api/auth/install", "POST", { ...data, email: "other@example.com" }),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  const cookie = results
    .find((result) => result.status === 200)
    .headers.get("set-cookie");
  assert.match(cookie, /HttpOnly/i);
  const authenticated = { Cookie: cookie.split(";")[0] };
  const bootstrap = await (
    await api("/api/bootstrap", "GET", undefined, authenticated)
  ).json();
  assert.equal(bootstrap.identity.admin, true);
  assert.equal(bootstrap.identity.provider, "local");
  assert.equal((await api("/auth/install")).headers.get("location"), "/login");
  assert.equal((await api("/api/auth/install", "POST", data)).status, 409);
  assert.equal(
    (
      await api(
        "/api/projects",
        "POST",
        {
          id: "installed",
          name: "Installed workspace",
          sourceLanguage: "en",
          languages: [{ code: "en", name: "English" }],
        },
        authenticated,
      )
    ).status,
    201,
  );
  assert.ok(!logs.includes(token));
  assert.equal(
    (
      await api(
        "/api/projects/installed/keys",
        "POST",
        { name: "hello", translations: { en: "Hello {name}" } },
        authenticated,
      )
    ).status,
    201,
  );
  const formatExport = await api(
    "/api/projects/installed/export?format=yaml",
    "GET",
    undefined,
    authenticated,
  );
  assert.equal(formatExport.status, 200);
  assert.deepEqual((await formatExport.json()).files, [
    { name: "en.yml", content: "hello: Hello {name}\n" },
  ]);
  assert.ok(!logs.includes(password));
  const manifest = JSON.parse(
    await readFile(join(packaged.directory, "release.json"), "utf8"),
  );
  assert.equal(manifest.publishable, false);
  assert.ok(manifest.uncompressedBytes < 200 * 1024 * 1024);
  console.log(
    `Packaged installer HTTP smoke passed: ${Math.round(manifest.bytes / 1024 / 1024)} MiB ZIP; native password hashing, static assets, secret/origin checks, atomic setup and permanent closure.`,
  );
} finally {
  if (server.exitCode === null) {
    server.kill("SIGTERM");
    await once(server, "exit");
  }
  await rm(directory, { recursive: true, force: true });
}
