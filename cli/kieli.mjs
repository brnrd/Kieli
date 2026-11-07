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
import { stripVTControlCharacters } from "node:util";

const help = `kieli — good words, every language

Commands:
  pull                  Bring translation files into your app
  push                  Preview source changes; add --apply to save

Start here:
  node cli/kieli.mjs pull --config .kieli.json --require-current
  node cli/kieli.mjs push --config .kieli.json

Connection:
  --config <file>       JSON config (default: .kieli.json when present)
  --url <origin>        Kieli origin (or KIELI_URL)
  --project <id>        Project ID (or KIELI_PROJECT)
  --demo                Local pull without a token; loopback only

Pull:
  --out <directory>     Destination directory (default: ./locales)
  --languages <codes>   Comma-separated codes; defaults to enabled project languages
  --format <format>     flat (default), nested, yaml, js, ts, php, properties,
                        ini, resx, po, pot, strings, stringsdict, plist, android, arb, xliff, csv
  --keys <names>        Pull up to 100 comma-separated key names
  --namespace <name>    Pull a namespace (cannot combine with --keys)
  --require-current     Stop if copy is missing, outdated or invalid
  --fallback            Use source copy for missing translations

Push:
  --source <file>       Source JSON (flat or nested)
  --language <code>     Source locale (default: en)
  --namespace <name>    Namespace for new keys (default: general)
  --apply               Save the previewed source changes
  --dry-run             Preview only; this is the default

Appearance:
  --plain               Plain output, without the character, color or progress
  --no-color            Disable color; also respects NO_COLOR
  --help                Show this help

Credentials belong in environment variables or your CI secret store:
  KIELI_TOKEN           Read-only project export token for pull
  KIELI_SYNC_TOKEN      Source-only project credential for push

No config yet? Pass --url and --project with your command.
Push defaults to a dry-run. Existing target translations stay protected.
Each locale is written as <code>.<extension>; stringsdict also writes a companion
.strings file. Unrelated files are preserved.
`;

/**
 * Terminal decoration stays in this portable file: the CLI can still be copied
 * into another repository without installing packages or companion modules.
 * @param {{stdout?: {write: (text: string) => unknown, isTTY?: boolean, columns?: number}, stderr?: {write: (text: string) => unknown}, env?: Record<string, string | undefined>, plain?: boolean, noColor?: boolean}} [options]
 */
export function createReporter({
  stdout = process.stdout,
  stderr = process.stderr,
  env = process.env,
  plain = false,
  noColor = false,
} = {}) {
  const ci = !!env.CI && !["0", "false"].includes(env.CI.toLowerCase());
  const human = !!stdout.isTTY && !ci && env.TERM !== "dumb" && !plain;
  const color = human && !noColor && env.NO_COLOR === undefined;
  const secrets = [
    env.KIELI_TOKEN,
    env.KIELI_SYNC_TOKEN,
    env.KIELI_MCP_TOKEN,
  ].filter(Boolean);
  const started = performance.now();
  function clean(value) {
    let text = String(value);
    for (const secret of secrets) text = text.split(secret).join("[redacted]");
    text = stripVTControlCharacters(text);
    return text.replace(
      /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g,
      "",
    );
  }
  const paint = (text, code) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
  function banner() {
    if (!human) return;
    if ((stdout.columns ?? 80) < 54) {
      stdout.write(`\n  ${paint("kieli", "1;32")}\n\n`);
      return;
    }
    stdout.write(
      `\n   ${paint(".--.", "32")}\n  ${paint("(o  o)---+", "32")}  ${paint("kieli", "1;32")}\n   ${paint("'--'   |", "32")}   Your words, ready to travel.\n\n`,
    );
  }
  return {
    human,
    clean,
    banner,
    help: () => {
      banner();
      stdout.write(help);
    },
    context: (project, command) => {
      if (human)
        stdout.write(
          `  ${paint(clean(project), "1")}  ${paint(clean(command), "2")}\n\n`,
        );
    },
    step: (message) => {
      if (human) stdout.write(`  ${paint(">", "32")} ${clean(message)}\n`);
    },
    success: (message) =>
      stdout.write(
        `${human ? "\n  " + paint("+", "32") + " " : ""}${clean(message)}\n`,
      ),
    file: (path) =>
      stdout.write(`  ${human ? paint("|", "2") + " " : ""}${clean(path)}\n`),
    note: (message) => stdout.write(`${human ? "  " : ""}${clean(message)}\n`),
    finish: () => {
      if (human)
        stdout.write(
          `\n  ${paint(`Done in ${((performance.now() - started) / 1000).toFixed(1)}s.`, "2")}\n`,
        );
    },
    failure: (error) =>
      stderr.write(
        `${human ? paint("  x kieli", "31") : "kieli"}: ${clean(error instanceof Error ? error.message : "Unable to complete this command.")}\n`,
      ),
  };
}
export function parseArgs(args, defaults = {}) {
  if (
    args.includes("--help") ||
    args.every((arg) => ["--plain", "--no-color"].includes(arg))
  )
    return { help: true };
  if (!["pull", "push"].includes(args[0]))
    throw new Error("Expected pull or push. Use --help for usage.");
  const options = {
    command: args[0],
    url: process.env.KIELI_URL ?? defaults.url ?? "",
    project: process.env.KIELI_PROJECT ?? defaults.project ?? "",
    out: defaults.out ?? "./locales",
    format: defaults.format ?? "flat",
    languages: defaults.languages ?? "",
    source: "",
    language: process.env.KIELI_SOURCE_LANGUAGE ?? defaults.language ?? "en",
    namespace: args[0] === "push" ? "general" : "",
    keys: "",
    config: "",
    files: defaults.files ?? [],
    apply: false,
    "dry-run": false,
    "require-current": defaults.requireCurrent ?? false,
    fallback: false,
    demo: false,
    plain: false,
    "no-color": false,
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
    "keys",
    "config",
  ]);
  for (let i = 1; i < args.length; i++) {
    const option = args[i]?.replace(/^--/, "");
    if (!args[i]?.startsWith("--"))
      throw new Error(`Unexpected argument: ${args[i]}`);
    if (
      [
        "fallback",
        "demo",
        "apply",
        "dry-run",
        "require-current",
        "plain",
        "no-color",
      ].includes(option)
    )
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
  if (options.command === "pull" && options.keys && options.namespace) throw new Error("Choose --keys or --namespace, not both.");
  if (options.languages) Intl.getCanonicalLocales(options.languages.split(","));
  if (options.command === "push") {
    if (
      args.some((arg) =>
        ["--out", "--languages", "--keys", "--fallback", "--require-current"].includes(
          arg,
        ),
      )
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
export async function pull(
  options,
  token = process.env.KIELI_TOKEN,
  onProgress = (_message) => {},
) {
  if (!token && !options.demo)
    throw new Error(
      "Set KIELI_TOKEN to a project export token, or use --demo on loopback.",
    );
  onProgress("Fetching translations…");
  const url = new URL(`/api/projects/${options.project}/export`, options.url);
  url.search = new URLSearchParams({
    format: options.format,
    languages: options.languages,
    fallback: String(options.fallback),
    requireCurrent: String(options["require-current"] ?? false),
    ...(options.keys ? { keys: options.keys } : {}),
    ...(options.namespace ? { namespace: options.namespace } : {}),
  }).toString();
  const response = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    redirect: "error",
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok)
    throw new Error(
      `Export failed (HTTP ${response.status}). ${response.status === 422 ? "Check missing or outdated copy, placeholder contracts and format compatibility." : "Check the project, token, and access permissions."}`,
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
          !(options.format === "stringsdict"
            ? /\.(?:stringsdict|strings)$/.test(file.name)
            : file.name.endsWith(`.${extension}`))
        )
          throw new Error("Invalid file export response.");
        return {
          code: file.name.slice(0, -(file.name.split(".").at(-1).length + 1)),
          name: file.name,
          content: file.content,
        };
      });
  if (!entries.length) throw new Error("The export contains no languages.");
  const seen = new Set();
  for (const { code, translations, name } of entries) {
    let canonical;
    try {
      canonical = Intl.getCanonicalLocales(code)[0];
    } catch {
      throw new Error("Export contains an invalid language code.");
    }
    if (canonical !== code || !/^[a-zA-Z0-9-]+$/.test(code))
      throw new Error("Export contains an unsafe language filename.");
    const identity = options.format === "stringsdict" ? name : code;
    if (seen.has(identity))
      throw new Error("Export contains duplicate locale filenames.");
    seen.add(identity);
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
  onProgress(
    `Writing ${entries.length} locale ${entries.length === 1 ? "file" : "files"}…`,
  );
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
  const path = resolve(explicit ? args[index + 1] : ".kieli.json");
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
    command === "push"
      ? ["files"]
      : ["out", "format", "languages", "requireCurrent"];
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
    (section.requireCurrent !== undefined &&
      typeof section.requireCurrent !== "boolean") ||
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
    requireCurrent: section.requireCurrent,
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
export async function push(
  options,
  token = process.env.KIELI_SYNC_TOKEN,
  onProgress = (_message) => {},
) {
  if (!token)
    throw new Error(
      "Set KIELI_SYNC_TOKEN to a source-sync credential. Export tokens cannot push.",
    );
  onProgress("Reading source files…");
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
  onProgress(
    `Previewing ${keys.length} source ${keys.length === 1 ? "key" : "keys"}…`,
  );
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
    onProgress(
      `Applying ${plans.length} ${plans.length === 1 ? "batch" : "batches"}…`,
    );
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
  const report = createReporter({
    plain: args.includes("--plain"),
    noColor: args.includes("--no-color"),
  });
  try {
    const helpOnly =
      args.includes("--help") ||
      args.every((arg) => ["--plain", "--no-color"].includes(arg));
    if (helpOnly) {
      report.help();
      return;
    }
    const options = parseArgs(args, await loadConfig(args));
    if (options.help) {
      report.help();
      return;
    }
    report.banner();
    report.context(
      options.project,
      options.command === "push"
        ? options.apply
          ? "push · apply"
          : "push · dry-run"
        : "pull",
    );
    if (options.command === "push") {
      const result = await push(
        options,
        process.env.KIELI_SYNC_TOKEN,
        report.step,
      );
      report.success(
        `${options.apply ? "Applied" : "Dry run"}: ${result.created} new, ${result.updated} updated, ${result.unchanged} unchanged source keys in ${options.project}.`,
      );
      if (!options.apply)
        report.note("No live copy changed. Run with --apply to save.");
    } else {
      const files = await pull(options, process.env.KIELI_TOKEN, report.step);
      report.success(
        `Pulled ${files.length} ${options.format === "stringsdict" ? "files" : files.length === 1 ? "language" : "languages"} from ${options.project}:`,
      );
      for (const path of files) report.file(path);
    }
    report.finish();
  } catch (error) {
    report.failure(error);
    process.exitCode = 1;
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await main();
