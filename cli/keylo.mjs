#!/usr/bin/env node
import {
  mkdir,
  rename,
  writeFile,
  unlink,
  readFile,
  stat,
} from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const help = `keylo — synchronize source copy and translations

Usage:
  KEYLO_TOKEN=… node cli/keylo.mjs pull --url https://copy.example.com --project website --out ./locales

Options:
  --config <file>       JSON config (default: .keylo.json when present)
  --source <file>       Source JSON for push (flat or nested)
  --language <code>     Source locale for push (default: en)
  --namespace <name>    Namespace for new pushed keys (default: general)
  --apply               Apply a source push; push defaults to dry-run
  --dry-run             Preview source changes without applying
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
Push requires KEYLO_SYNC_TOKEN; it cannot write target translations.
  KEYLO_SYNC_TOKEN=… node cli/keylo.mjs push --config .keylo.json --apply
Each locale is written as <code>.<extension>. Existing unrelated files are preserved.
`;
export function parseArgs(args, defaults = {}) {
  if (args.includes("--help") || !args.length) return { help: true };
  if (!["pull", "push"].includes(args[0]))
    throw new Error("Expected pull or push. Use --help for usage.");
  const options = {
    command: args[0],
    url: process.env.KEYLO_URL ?? defaults.url ?? "",
    project: process.env.KEYLO_PROJECT ?? defaults.project ?? "",
    out: defaults.out ?? "./locales",
    format: defaults.format ?? "flat",
    languages: defaults.languages ?? "",
    source: "",
    language: process.env.KEYLO_SOURCE_LANGUAGE ?? defaults.language ?? "en",
    namespace: "general",
    config: "",
    files: defaults.files ?? [],
    apply: false,
    "dry-run": false,
    fallback: false,
    demo: false,
  };
  const valued = new Set([
    "url",
    "project",
    "out",
    "format",
    "languages",
    "source",
    "language",
    "namespace",
    "config",
  ]);
  for (let i = 1; i < args.length; i++) {
    const option = args[i]?.replace(/^--/, "");
    if (!args[i]?.startsWith("--"))
      throw new Error(`Unexpected argument: ${args[i]}`);
    if (["fallback", "demo", "apply", "dry-run"].includes(option))
      options[option] = true;
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
  if (options.command === "push") {
    if (
      args.some((arg) => ["--out", "--languages", "--fallback"].includes(arg))
    )
      throw new Error("Pull options cannot be used with push.");
    if (options.demo)
      throw new Error(
        "Push always requires a source-sync credential; --demo is not supported.",
      );
    if (options.apply && options["dry-run"])
      throw new Error("Choose --apply or --dry-run.");
    if (!["flat", "nested"].includes(options.format))
      throw new Error(
        "Source push supports flat or nested JSON; use ICU strings for plurals.",
      );
    if (Intl.getCanonicalLocales(options.language)[0] !== options.language)
      throw new Error("Use a canonical source --language.");
    if (!options.source && !options.files.length)
      throw new Error("Set --source or configure push.files.");
  } else if (options.apply || options["dry-run"] || options.source)
    throw new Error("Push options cannot be used with pull.");
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

export async function loadConfig(args) {
  if (!args.length || args.includes("--help")) return {};
  const index = args.indexOf("--config"),
    explicit = index >= 0;
  if (explicit && (!args[index + 1] || args[index + 1].startsWith("--")))
    throw new Error("Missing value for --config");
  const path = resolve(explicit ? args[index + 1] : ".keylo.json");
  let bytes;
  try {
    if ((await stat(path)).size > 65536)
      throw new Error("Configuration exceeds 64 KiB.");
    bytes = await readFile(path, "utf8");
  } catch (error) {
    if (!explicit && error.code === "ENOENT") return {};
    throw error;
  }
  const config = JSON.parse(bytes);
  if (!config || typeof config !== "object" || Array.isArray(config))
    throw new Error("Expected a JSON configuration object.");
  if (
    Object.keys(config).some(
      (key) =>
        !["url", "project", "sourceLanguage", "push", "pull"].includes(key),
    )
  )
    throw new Error(
      "Unsupported configuration field. Keep credentials in environment variables.",
    );
  const command = args[0],
    section = config[command] ?? {};
  if (!section || typeof section !== "object" || Array.isArray(section))
    throw new Error("Invalid command configuration.");
  const allowed =
    command === "push" ? ["files"] : ["out", "format", "languages"];
  if (Object.keys(section).some((key) => !allowed.includes(key)))
    throw new Error("Unsupported command configuration field.");
  const files = command === "push" ? (section.files ?? []) : [];
  if (!Array.isArray(files) || files.length > 100)
    throw new Error("Configure at most 100 source files.");
  const mapped = files.map((file) => {
    if (
      !file ||
      typeof file !== "object" ||
      Object.keys(file).some(
        (key) => !["path", "format", "namespace"].includes(key),
      ) ||
      typeof file.path !== "string" ||
      !file.path ||
      !["flat", "nested"].includes(file.format ?? "flat") ||
      (file.namespace !== undefined && typeof file.namespace !== "string")
    )
      throw new Error("Invalid push file mapping.");
    return { ...file, path: resolve(dirname(path), file.path) };
  });
  if (
    (config.url !== undefined && typeof config.url !== "string") ||
    (config.project !== undefined && typeof config.project !== "string") ||
    (config.sourceLanguage !== undefined &&
      typeof config.sourceLanguage !== "string")
  )
    throw new Error("Invalid configuration values.");
  if (
    (section.out !== undefined && typeof section.out !== "string") ||
    (section.format !== undefined && typeof section.format !== "string") ||
    (section.languages !== undefined &&
      (!Array.isArray(section.languages) ||
        section.languages.some((value) => typeof value !== "string")))
  )
    throw new Error("Invalid pull configuration.");
  return {
    url: config.url,
    project: config.project,
    language: config.sourceLanguage,
    out: section.out ? resolve(dirname(path), section.out) : undefined,
    format: section.format,
    languages: section.languages?.join(","),
    files: mapped,
  };
}
export function sourceKeys(text, format = "flat", namespace = "general") {
  if (!["flat", "nested"].includes(format))
    throw new Error("Source push supports flat or nested JSON.");
  const root = JSON.parse(text.replace(/^\uFEFF/, "")),
    result = new Map();
  function visit(value, path, depth) {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      depth > 32
    )
      throw new Error("Expected a bounded JSON object of source strings.");
    for (const [segment, item] of Object.entries(value)) {
      const parts = [...path, segment],
        name = parts.join(".");
      if (
        !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,179}$/.test(name) ||
        name
          .split(".")
          .some(
            (part) =>
              !part || ["__proto__", "constructor", "prototype"].includes(part),
          )
      )
        throw new Error("Invalid source key name.");
      if (typeof item === "string") {
        if (item.length > 20000)
          throw new Error("Source copy exceeds 20,000 characters.");
        if (result.has(name)) throw new Error(`Duplicate source key ${name}.`);
        result.set(name, { name, namespace, text: item });
      } else if (
        format === "nested" &&
        item &&
        typeof item === "object" &&
        !Array.isArray(item)
      ) {
        if (
          Object.hasOwn(item, "other") &&
          Object.keys(item).every((key) =>
            ["zero", "one", "two", "few", "many", "other"].includes(key),
          )
        )
          throw new Error(
            "Use ICU message strings for pushed plurals, not plural category objects.",
          );
        visit(item, parts, depth + 1);
      } else
        throw new Error(
          "Source values must be strings; nested JSON needs --format nested.",
        );
    }
  }
  visit(root, [], 0);
  if (!result.size) throw new Error("No source strings found.");
  return [...result.values()];
}
async function syncRequest(options, path, body, token) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(
        new URL(`/sync/${options.project}/${path}`, options.url),
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body ?? {}),
          redirect: "error",
          signal: AbortSignal.timeout(30000),
        },
      );
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        const retry = Number(response.headers.get("retry-after") ?? 60);
        await response.body?.cancel();
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            response.status === 429
              ? Math.min(
                  60000,
                  Math.max(1000, (Number.isFinite(retry) ? retry : 60) * 1000),
                )
              : 200 * (attempt + 1),
          ),
        );
        continue;
      }
      const chunks = [];
      let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > 2 * 1024 * 1024)
          throw new Error("Source-sync response exceeds 2 MiB.");
        chunks.push(chunk);
      }
      const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!response.ok) {
        const error = new Error(
          `Source sync failed (HTTP ${response.status}): ${typeof result.error === "string" ? result.error : "check credential and project access."}`,
        );
        error.status = response.status;
        throw error;
      }
      return result;
    } catch (error) {
      if (
        error.status ||
        attempt === 2 ||
        !(error instanceof TypeError || error.name === "TimeoutError")
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
    }
  }
}
export async function push(options, token = process.env.KEYLO_SYNC_TOKEN) {
  if (!token)
    throw new Error(
      "Set KEYLO_SYNC_TOKEN to a source-sync credential. Export tokens cannot push.",
    );
  const files = options.source
    ? [
        {
          path: resolve(options.source),
          format: options.format,
          namespace: options.namespace,
        },
      ]
    : options.files;
  const byName = new Map();
  let total = 0;
  for (const file of files) {
    const info = await stat(file.path);
    total += info.size;
    if (info.size > 10 * 1024 * 1024 || total > 25 * 1024 * 1024)
      throw new Error(
        "Source files exceed the 10 MiB per-file or 25 MiB total limit.",
      );
    for (const key of sourceKeys(
      await readFile(file.path, "utf8"),
      file.format ?? "flat",
      file.namespace ?? "general",
    )) {
      if (byName.has(key.name))
        throw new Error(`Duplicate source key ${key.name} across files.`);
      byName.set(key.name, key);
    }
    if (byName.size > 50000)
      throw new Error("Push at most 50,000 source keys.");
  }
  const keys = [],
    done = new Set(),
    visiting = new Set();
  function visit(name, depth = 0) {
    if (done.has(name)) return;
    if (visiting.has(name) || depth > 20)
      throw new Error("Circular or over-deep source reference.");
    const key = byName.get(name);
    if (!key) return;
    visiting.add(name);
    for (const match of key.text.matchAll(
      /\[%key:([a-zA-Z0-9_][a-zA-Z0-9_.-]*)%\]/g,
    ))
      visit(match[1], depth + 1);
    visiting.delete(name);
    done.add(name);
    keys.push({
      name: key.name,
      namespace: key.namespace,
      translations: { [options.language]: key.text },
    });
  }
  for (const name of byName.keys()) visit(name);
  const groups = [];
  let group = [],
    bytes = 0;
  for (const key of keys) {
    const size = Buffer.byteLength(JSON.stringify(key));
    if (group.length && (group.length === 20 || bytes + size > 180000)) {
      groups.push(group);
      group = [];
      bytes = 0;
    }
    group.push(key);
    bytes += size;
  }
  if (group.length) groups.push(group);
  const plans = [];
  async function preview(batch) {
    try {
      const plan = await syncRequest(
        options,
        "preview",
        { keys: batch },
        token,
      );
      if (!/^[a-f0-9-]{36}$/.test(plan.id))
        throw new Error("Invalid source-sync preview response.");
      plans.push(plan);
    } catch (error) {
      if (error.status === 413 && batch.length > 1) {
        const middle = Math.ceil(batch.length / 2);
        await preview(batch.slice(0, middle));
        await preview(batch.slice(middle));
      } else throw error;
    }
  }
  for (const batch of groups) await preview(batch);
  const result = { created: 0, updated: 0, unchanged: 0 };
  for (const plan of plans) {
    for (const key of Object.keys(result)) {
      if (!Number.isSafeInteger(plan[key]) || plan[key] < 0)
        throw new Error("Invalid source-sync counts.");
      result[key] += plan[key];
    }
  }
  if (options.apply)
    for (const plan of plans)
      try {
        await syncRequest(options, `apply/${plan.id}`, {}, token);
      } catch (error) {
        throw new Error(
          `${error.message} Earlier batches may already be saved; rerun a dry-run before applying again.`,
        );
      }
  return result;
}

export async function main(args = process.argv.slice(2)) {
  try {
    const options = parseArgs(args, await loadConfig(args));
    if (options.help) {
      console.log(help);
      return;
    }
    if (options.command === "push") {
      if (
        args.some((arg) => ["--out", "--languages", "--fallback"].includes(arg))
      )
        throw new Error("Pull options cannot be used with push.");
      const result = await push(options);
      console.log(
        `${options.apply ? "Applied" : "Dry run"}: ${result.created} new, ${result.updated} updated, ${result.unchanged} unchanged source keys in ${options.project}.`,
      );
      if (!options.apply)
        console.log("No live copy changed. Run with --apply to save.");
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
