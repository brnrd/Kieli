#!/usr/bin/env node
import { mkdir, rename, writeFile, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const help = `keylo — pull your product's words into your repository

Usage:
  KEYLO_TOKEN=… node cli/keylo.mjs pull --url https://copy.example.com --project website --out ./locales

Options:
  --url <origin>        Keylo origin (or KEYLO_URL)
  --project <id>        Project ID (or KEYLO_PROJECT)
  --out <directory>     Destination directory (default: ./locales)
  --languages <codes>   Comma-separated codes; defaults to all project languages
  --format <format>     flat (default), nested, yaml, js, ts, php, properties,
                        ini, resx, po, pot, strings, plist, android, arb, xliff, csv
  --fallback            Use source copy for missing translations
  --demo                Allow a local demo server without a token
  --help                Show this help

Set KEYLO_TOKEN through your environment or CI secret store. Never pass it on the command line.
Each locale is written as <code>.<extension>. Existing unrelated files are preserved.
`;
export function parseArgs(args) {
  if (args.includes("--help") || !args.length) return { help: true };
  if (args[0] !== "pull")
    throw new Error("Expected the pull command. Use --help for usage.");
  const options = {
    url: process.env.KEYLO_URL ?? "",
    project: process.env.KEYLO_PROJECT ?? "",
    out: "./locales",
    format: "flat",
    languages: "",
    fallback: false,
    demo: false,
  };
  const valued = new Set(["url", "project", "out", "format", "languages"]);
  for (let i = 1; i < args.length; i++) {
    const option = args[i]?.replace(/^--/, "");
    if (!args[i]?.startsWith("--"))
      throw new Error(`Unexpected argument: ${args[i]}`);
    if (option === "fallback" || option === "demo") options[option] = true;
    else if (valued.has(option)) {
      const value = args[++i];
      if (!value || value.startsWith("--"))
        throw new Error(`Missing value for --${option}`);
      options[option] = value;
    } else throw new Error(`Unknown option: --${option}`);
  }
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(options.project))
    throw new Error("A valid --project ID is required.");
  let url;
  try {
    url = new URL(options.url);
  } catch {
    throw new Error("A valid --url origin is required.");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error(
      "--url must be an origin without credentials, path, or query.",
    );
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local))
    throw new Error("HTTPS is required outside loopback.");
  if (options.demo && !local)
    throw new Error("--demo is only allowed on loopback.");
  if (!/^[a-z]{2,20}$/.test(options.format))
    throw new Error("Invalid --format. Use --help for supported formats.");
  if (options.languages) Intl.getCanonicalLocales(options.languages.split(","));
  return { ...options, url: url.origin };
}
export async function pull(options, token = process.env.KEYLO_TOKEN) {
  if (!token && !options.demo)
    throw new Error(
      "Set KEYLO_TOKEN to a project export token, or use --demo on loopback.",
    );
  const url = new URL(`/api/projects/${options.project}/export`, options.url);
  url.search = new URLSearchParams({
    format: options.format,
    languages: options.languages,
    fallback: String(options.fallback),
  }).toString();
  const response = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    redirect: "error",
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok)
    throw new Error(
      `Export failed (HTTP ${response.status}). Check the project, token, and access permissions.`,
    );
  // Bound responses even if Content-Length is absent.
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > 25 * 1024 * 1024)
      throw new Error(
        "Export exceeds the 25 MB safety limit. Pull fewer languages.",
      );
    chunks.push(chunk);
  }
  const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (
    data.project !== options.project ||
    (data.format && data.format !== options.format)
  )
    throw new Error("Unexpected export response.");
  const json = ["flat", "nested"].includes(options.format);
  if (
    json &&
    (!data.translations ||
      typeof data.translations !== "object" ||
      Array.isArray(data.translations))
  )
    throw new Error("Unexpected export response.");
  if (!json && (!Array.isArray(data.files) || data.format !== options.format))
    throw new Error("Unexpected file export response.");
  const extension =
    { flat: "json", nested: "json", yaml: "yml", android: "xml" }[
      options.format
    ] ?? options.format;
  const entries = json
    ? Object.entries(data.translations).map(([code, translations]) => ({
        code,
        name: `${code}.json`,
        translations,
        content: JSON.stringify(translations, null, 2) + "\n",
      }))
    : data.files.map((file) => {
        if (
          !file ||
          typeof file.name !== "string" ||
          typeof file.content !== "string" ||
          !file.name.endsWith(`.${extension}`)
        )
          throw new Error("Invalid file export response.");
        return {
          code: file.name.slice(0, -(extension.length + 1)),
          name: file.name,
          content: file.content,
        };
      });
  if (!entries.length) throw new Error("The export contains no languages.");
  const seen = new Set();
  for (const { code, translations } of entries) {
    let canonical;
    try {
      canonical = Intl.getCanonicalLocales(code)[0];
    } catch {
      throw new Error("Export contains an invalid language code.");
    }
    if (canonical !== code || !/^[a-zA-Z0-9-]+$/.test(code))
      throw new Error("Export contains an unsafe language filename.");
    if (seen.has(code))
      throw new Error("Export contains duplicate locale filenames.");
    seen.add(code);
    if (
      options.languages &&
      !options.languages
        .split(",")
        .map((code) => Intl.getCanonicalLocales(code)[0])
        .includes(code)
    )
      throw new Error("Export contains an unrequested language.");
    if (
      json &&
      (!translations ||
        typeof translations !== "object" ||
        Array.isArray(translations))
    )
      throw new Error("Invalid translations in export response.");
  }
  const directory = resolve(options.out);
  await mkdir(directory, { recursive: true });
  for (const { code, name, content } of entries) {
    const temporary = join(directory, `.${code}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, content, {
        flag: "wx",
        mode: 0o644,
      });
      await rename(temporary, join(directory, name));
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
  return entries.map(({ name }) => join(directory, name));
}
export async function main(args = process.argv.slice(2)) {
  try {
    const options = parseArgs(args);
    if (options.help) {
      console.log(help);
      return;
    }
    const files = await pull(options);
    console.log(
      `Pulled ${files.length} ${files.length === 1 ? "language" : "languages"} from ${options.project}:\n${files.map((p) => `  ${p}`).join("\n")}`,
    );
  } catch (error) {
    console.error(`keylo: ${error.message}`);
    process.exitCode = 1;
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await main();
