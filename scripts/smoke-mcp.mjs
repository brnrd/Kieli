import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// Real Streamable HTTP against the compiled Astro endpoint; no real project data.
const directory = await mkdtemp(join(tmpdir(), "keylo-mcp-"));
const origin = "http://127.0.0.1:4328";
const server = spawn(process.execPath, ["dist/server/entry.mjs"], {
  env: {
    ...process.env,
    NODE_ENV: "development",
    AUTH_MODE: "demo",
    STORAGE_DRIVER: "sqlite",
    SQLITE_PATH: join(directory, "data.sqlite"),
    HOST: "127.0.0.1",
    PORT: "4328",
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
const client = new Client({ name: "keylo-http-smoke", version: "1" });
const api = (path, method = "GET", data, headers = {}) =>
  fetch(origin + path, {
    method,
    redirect: "manual",
    headers: { origin, "content-type": "application/json", ...headers },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
try {
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (server.exitCode !== null) throw new Error(`Server failed: ${logs}`);
    try {
      ready = (await fetch(origin + "/api/health")).ok;
    } catch {}
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, `Server did not become ready: ${logs}`);
  assert.equal(
    (
      await api("/api/projects", "POST", {
        id: "mcp-smoke",
        name: "MCP smoke",
        sourceLanguage: "en",
        languages: [
          { code: "en", name: "English" },
          { code: "fr", name: "French" },
        ],
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await api("/api/projects/mcp-smoke/keys", "POST", {
        name: "home.title",
        translations: { en: "Hello {name}", fr: "" },
      })
    ).status,
    201,
  );
  const created = await api("/api/projects/mcp-smoke/mcp-tokens", "POST", {
    name: "Smoke Claude",
    languages: ["fr"],
  });
  assert.equal(created.status, 201);
  const { secret, credential } = await created.json();
  const headers = { authorization: `Bearer ${secret}` };
  assert.equal(
    (
      await api(
        "/mcp",
        "POST",
        {},
        { origin: "https://evil.example", ...headers },
      )
    ).status,
    403,
  );
  assert.equal((await api("/mcp", "POST", {})).status, 401);
  assert.equal(
    (await api("/api/bootstrap", "GET", undefined, headers)).status,
    401,
  );
  assert.equal(
    (await api("/api/projects/mcp-smoke/export", "GET", undefined, headers))
      .status,
    401,
  );
  const exported = await (
    await api("/api/projects/mcp-smoke/tokens", "POST", {
      name: "Export",
      expiresInDays: 30,
    })
  ).json();
  assert.equal(
    (
      await api(
        "/mcp",
        "POST",
        {},
        { authorization: `Bearer ${exported.secret}` },
      )
    ).status,
    401,
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(origin + "/mcp"), {
      requestInit: { headers },
    }),
  );
  assert.equal((await client.listTools()).tools.length, 4);
  const read = await client.callTool({
    name: "get_key",
    arguments: { key: "home.title" },
  });
  const key = JSON.parse(read.content[0].text);
  assert.equal(key.source, "Hello {name}");
  const saved = await client.callTool({
    name: "set_translations",
    arguments: {
      updates: [
        {
          key: key.key,
          expectedVersion: key.version,
          translations: { fr: "Bonjour {name}" },
        },
      ],
    },
  });
  assert.ok(!saved.isError);
  const stale = await client.callTool({
    name: "set_translations",
    arguments: {
      updates: [
        {
          key: key.key,
          expectedVersion: key.version,
          translations: { fr: "Stale" },
        },
      ],
    },
  });
  assert.equal(stale.isError, true);
  assert.equal(JSON.parse(stale.content[0].text).status, 409);
  const list = await (await api("/api/projects/mcp-smoke/mcp-tokens")).json();
  assert.ok(list[0].lastUsedAt);
  assert.ok(!JSON.stringify(list).includes(secret));
  const page = await (await api("/api/projects/mcp-smoke/keys")).json();
  assert.equal(page.items[0].translations.fr, "Bonjour {name}");
  assert.equal(page.items[0].translations.en, "Hello {name}");
  assert.equal(page.stats.byLanguage.fr, 1);
  assert.equal(
    (await api(`/api/projects/mcp-smoke/mcp-tokens/${credential.id}`, "DELETE"))
      .status,
    204,
  );
  await assert.rejects(client.listTools());
  console.log(
    "MCP HTTP smoke passed: official SDK handshake, scoped read/write, concurrency, credential separation and revocation.",
  );
} finally {
  await client.close();
  if (server.exitCode === null) {
    server.kill("SIGTERM");
    await once(server, "exit");
  }
  await rm(directory, { recursive: true, force: true });
}
