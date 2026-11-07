import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
const directory = await mkdtemp(join(tmpdir(), "kieli-languages-"));
const origin = "http://127.0.0.1:4344";
const server = spawn(process.execPath, ["dist/server/entry.mjs"], {
  env: {
    ...process.env,
    NODE_ENV: "development",
    AUTH_MODE: "demo",
    STORAGE_DRIVER: "sqlite",
    SQLITE_PATH: join(directory, "data.sqlite"),
    HOST: "127.0.0.1",
    PORT: "4344",
    APP_ORIGIN: origin,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
server.stdout.on("data", (data) => (logs += data));
server.stderr.on("data", (data) => (logs += data));
const api = (path, method = "GET", body) =>
  fetch(`${origin}/api/projects${path}`, {
    method,
    headers: { origin, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
async function json(response, status = 200) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}
try {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (server.exitCode !== null) throw Error(logs);
    try {
      ready = (await fetch(`${origin}/api/health`)).ok;
    } catch {}
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, logs);
  await json(
    await api("", "POST", {
      id: "web",
      name: "Language smoke",
      sourceLanguage: "en",
      languages: [
        { code: "en", name: "English" },
        { code: "fr", name: "French" },
      ],
    }),
    201,
  );
  const key = await json(
    await api("/web/keys", "POST", {
      name: "hello",
      translations: { en: "Hello", fr: "Bonjour" },
    }),
    201,
  );
  await json(
    await api("/web/keys", "POST", {
      name: "linked",
      translations: { en: "[%key:hello%]", fr: "[%key:hello%]" },
    }),
    201,
  );
  const token = await json(
    await api("/web/tokens", "POST", { name: "Existing CI" }),
    201,
  );
  const disabled = await json(
    await api("/web/languages/fr", "POST", { version: 1, enabled: false }),
  );
  assert.equal(disabled.languages[1].disabled, true);
  assert.equal(
    (await api("/web/languages/en", "POST", { version: 2, enabled: false }))
      .status,
    400,
  );
  assert.equal(
    (
      await api("/web/keys/hello", "PATCH", {
        version: key.version,
        translations: { fr: "Changed" },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await api("/web/updates/preview", "POST", {
        keys: [{ name: "hello", translations: { fr: "Changed" } }],
      })
    ).status,
    409,
  );
  assert.equal((await api("/web/keys?language=fr")).status, 409);
  const page = await json(await api("/web/keys?status=complete"));
  assert.equal(page.items.length, 2);
  const headers = { authorization: `Bearer ${token.secret}` };
  const getExport = (languages = "") =>
    fetch(
      `${origin}/api/projects/web/export?format=flat&languages=${languages}`,
      { headers },
    );
  assert.deepEqual(Object.keys((await json(await getExport())).translations), [
    "en",
  ]);
  assert.equal(
    (await json(await getExport("fr"))).translations.fr.hello,
    "Bonjour",
  );
  assert.equal(
    (
      await fetch(`${origin}/api/projects/web/languages/fr`, {
        method: "POST",
        headers: { ...headers, origin, "content-type": "application/json" },
        body: JSON.stringify({ version: disabled.version, enabled: true }),
      })
    ).status,
    403,
  );
  for (const explicit of [false, true]) {
    const output = join(directory, explicit ? "explicit" : "default");
    const cli = spawnSync(
      process.execPath,
      [
        "cli/kieli.mjs",
        "pull",
        "--url",
        origin,
        "--project",
        "web",
        "--format",
        "flat",
        "--out",
        output,
        "--plain",
        ...(explicit ? ["--languages", "fr"] : []),
      ],
      {
        env: { ...process.env, KIELI_TOKEN: token.secret },
        encoding: "utf8",
        timeout: 20000,
      },
    );
    assert.equal(cli.status, 0, cli.stderr);
    const files = await readdir(output);
    assert.deepEqual(files, [explicit ? "fr.json" : "en.json"]);
    if (explicit)
      assert.equal(
        JSON.parse(await readFile(join(output, "fr.json"), "utf8")).hello,
        "Bonjour",
      );
  }
  assert.equal(
    (await api("/web/languages/fr", "POST", { version: 1, enabled: true }))
      .status,
    409,
  );
  await json(
    await api("/web/languages/fr", "POST", {
      version: disabled.version,
      enabled: true,
    }),
  );
  await json(
    await api("/web/keys/hello", "PATCH", {
      version: key.version,
      translations: { fr: "Salut" },
    }),
  );
  assert.equal(
    (await json(await api("/web/keys/hello"))).translations.fr,
    "Salut",
  );
  console.log(
    "Language lifecycle HTTP/CLI smoke passed: disable/enable, source and credential boundaries, write/import guards, default export exclusion and explicit retained-copy pulls.",
  );
} finally {
  if (server.exitCode === null) {
    server.kill("SIGTERM");
    await once(server, "exit");
  }
  await rm(directory, { recursive: true, force: true });
}
