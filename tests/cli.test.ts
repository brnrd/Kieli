import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// The CLI is deliberately plain JavaScript so it runs without an install step.
import { parseArgs, pull } from "../cli/keylo.mjs";

test("CLI validates origins, options, project IDs, and transport security", () => {
  assert.throws(
    () =>
      parseArgs(["pull", "--url", "http://example.com", "--project", "site"]),
    /HTTPS/,
  );
  assert.throws(
    () =>
      parseArgs([
        "pull",
        "--url",
        "https://example.com/other",
        "--project",
        "site",
      ]),
    /origin/,
  );
  assert.throws(
    () =>
      parseArgs([
        "pull",
        "--url",
        "https://example.com",
        "--project",
        "../site",
      ]),
    /project/,
  );
  assert.throws(
    () =>
      parseArgs([
        "pull",
        "--url",
        "https://example.com",
        "--project",
        "site",
        "--demo",
      ]),
    /loopback/,
  );
  assert.throws(() => parseArgs(["pull", "--token", "secret"]), /Unknown/);
  assert.throws(() => parseArgs(["pull", "--url"]), /Missing value/);
  assert.equal(parseArgs(["--help"]).help, true);
  const local = parseArgs([
    "pull",
    "--url",
    "http://127.0.0.1:4321",
    "--project",
    "site",
    "--demo",
  ]);
  assert.equal("demo" in local && local.demo, true);
});
test("CLI sends bearer authorization and writes individual locale files atomically", async () => {
  const directory = await mkdtemp(join(tmpdir(), "keylo-cli-"));
  const originalFetch = globalThis.fetch;
  try {
    await writeFile(join(directory, "untouched.txt"), "keep");
    globalThis.fetch = (async (
      input: string | URL | Request,
      options?: RequestInit,
    ) => {
      assert.equal(
        (options?.headers as Record<string, string>).Authorization,
        "Bearer test-token",
      );
      assert.equal(options?.redirect, "error");
      assert.equal(
        new URL(String(input)).searchParams.get("languages"),
        "en,fr",
      );
      return Response.json({
        project: "site",
        translations: { en: { hello: "Hello" }, fr: { hello: "Bonjour" } },
      });
    }) as typeof fetch;
    const files = await pull(
      {
        url: "https://example.com",
        project: "site",
        out: directory,
        format: "flat",
        languages: "en,fr",
        fallback: false,
      },
      "test-token",
    );
    assert.equal(files.length, 2);
    assert.equal(
      await readFile(join(directory, "en.json"), "utf8"),
      '{\n  "hello": "Hello"\n}\n',
    );
    assert.equal(
      await readFile(join(directory, "untouched.txt"), "utf8"),
      "keep",
    );
    assert.equal(
      (await readdir(directory)).some((f) => f.endsWith(".tmp")),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});
test("CLI fails closed on HTTP errors, missing credentials, and malicious locale filenames", async () => {
  const originalFetch = globalThis.fetch;
  const options = {
    url: "https://example.com",
    project: "site",
    out: "/not-created",
    format: "flat",
    languages: "",
    fallback: false,
  };
  try {
    await assert.rejects(pull(options, ""), /KEYLO_TOKEN/);
    globalThis.fetch = (async () =>
      new Response("", { status: 401 })) as typeof fetch;
    await assert.rejects(pull(options, "test-token"), /HTTP 401/);
    globalThis.fetch = (async () =>
      Response.json({
        project: "site",
        translations: { "../../escape": { hello: "hello" } },
      })) as typeof fetch;
    await assert.rejects(pull(options, "test-token"), /invalid language code/);
    globalThis.fetch = (async () =>
      Response.json({
        project: "other",
        translations: { en: {} },
      })) as typeof fetch;
    await assert.rejects(pull(options, "test-token"), /Unexpected export/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CLI pulls native format files and validates the whole response before writing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "keylo-cli-native-"));
  const originalFetch = globalThis.fetch;
  const options = {
    url: "https://example.com",
    project: "site",
    out: directory,
    format: "strings",
    languages: "fr",
    fallback: false,
  };
  try {
    let files = [{ name: "fr.strings", content: '"hello" = "Bonjour";\n' }];
    globalThis.fetch = (async () =>
      Response.json({
        project: "site",
        format: "strings",
        files,
      })) as typeof fetch;
    await pull(options, "test-token");
    assert.equal(
      await readFile(join(directory, "fr.strings"), "utf8"),
      files[0]!.content,
    );
    files = [
      { name: "fr.strings", content: "should not write" },
      { name: "../en.strings", content: "unsafe" },
    ];
    await assert.rejects(pull(options, "test-token"), /language/);
    assert.equal(
      await readFile(join(directory, "fr.strings"), "utf8"),
      '"hello" = "Bonjour";\n',
    );
    files = [{ name: "fr.js", content: "wrong extension" }];
    await assert.rejects(pull(options, "test-token"), /Invalid file/);
    files = [{ name: "en.strings", content: "unrequested" }];
    await assert.rejects(pull(options, "test-token"), /unrequested/);
    files = [
      { name: "fr.strings", content: "first" },
      { name: "fr.strings", content: "duplicate" },
    ];
    await assert.rejects(pull(options, "test-token"), /duplicate/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});
